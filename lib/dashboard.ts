import "server-only";
import { USAGE_TOOLS } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

export const RANGES = {
  "24h": { label: "24 hours", spanS: 86_400, bucketS: 600 },
  "7d": { label: "7 days", spanS: 7 * 86_400, bucketS: 3_600 },
  "30d": { label: "30 days", spanS: 30 * 86_400, bucketS: 4 * 3_600 },
} as const;
export type RangeKey = keyof typeof RANGES;

export function parseRange(value: string | string[] | undefined): RangeKey {
  return typeof value === "string" && value in RANGES ? (value as RangeKey) : "24h";
}

export type UsageTool = (typeof USAGE_TOOLS)[number];

/** One chart point. `t` is epoch ms (bucket start); null values break the line. */
export type ModulePoint = { t: number; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null; lux: number | null };
export type UsagePoint = { t: number; session_pct: number | null; week_pct: number | null; month_pct: number | null };

export type ModuleLatest = {
  temp_c: number | null;
  hum_pct: number | null;
  pressure_hpa: number | null;
  iaq: number | null;
  lux: number | null;
  /** When the newest reading was taken (epoch ms). */
  ts: number;
};

export type ModuleStatus = {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  fw: string | null;
  batt_pct: number | null;
  power_source: string | null;
  wifi_ssid: string | null;
  wifi_rssi: number | null;
  /** Epoch ms; null until its first report. */
  last_seen: number | null;
  latest: ModuleLatest | null;
};

export type UsageLatest = {
  name: UsageTool;
  measured_at: number;
  /** Null for a tool without this window. 0 once the session has reset. */
  session_pct: number | null;
  session_resets_at: number | null;
  week_pct: number | null;
  week_resets_at: number | null;
  month_pct: number | null;
  month_resets_at: number | null;
};

export type DashboardEvent = { id: string | null; title: string; start: number; end: number };

export type DashboardData = {
  range: RangeKey;
  from: number;
  now: number;
  /** Every module, most recently seen first. */
  modules: ModuleStatus[];
  /** The module in focus, with its history. */
  selected: { module: ModuleStatus; series: ModulePoint[] } | null;
  usage: { tool: UsageTool; series: UsagePoint[]; latest: UsageLatest | null }[];
  events: DashboardEvent[];
  /** When the calendar last sent a snapshot (epoch ms). */
  eventsSyncedAt: number | null;
  /** A usable events key exists, so the calendar can sync even if it hasn't yet. */
  eventsKeyActive: boolean;
};

type StoredEvent = { id: string | null; title: string; starts_at: string; ends_at: string };
type ModuleBucketRow = { bucket: string; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null; lux: number | null };
type UsageBucketRow = { bucket: string; name: UsageTool; session_pct: number | null; week_pct: number | null; month_pct: number | null };
type DeviceRow = {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  last_seen_at: string | null;
  report: { fw: string | null; batt_pct: number | null; power_source: string | null; wifi_ssid: string | null; wifi_rssi: number | null } | null;
};
type ReadingRow = { ts: string; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null; lux: number | null };

const ms = (iso: string) => new Date(iso).getTime();
const round = (v: number | null, digits: number) => (v === null ? null : Number(v.toFixed(digits)));

// Every bucket start in [from, now], so missing data shows as a gap instead of a straight line across it.
function buckets(from: number, now: number, bucketMs: number) {
  const out: number[] = [];
  for (let t = from; t <= now; t += bucketMs) out.push(t);
  return out;
}

/** Newest non-null value per sensor from a device's recent rows: sensors report null while warming up. */
function latestReading(rows: ReadingRow[]): ModuleLatest | null {
  if (!rows.length) return null;
  const pick = (field: keyof Omit<ReadingRow, "ts">) => rows.find((r) => r[field] !== null)?.[field] ?? null;
  return { temp_c: pick("temp_c"), hum_pct: pick("hum_pct"), pressure_hpa: pick("pressure_hpa"), iaq: pick("iaq"), lux: pick("lux"), ts: ms(rows[0].ts) };
}

async function getModules(): Promise<ModuleStatus[]> {
  const devices = await supabase
    .from("devices")
    .select("id, name, latitude, longitude, last_seen_at, report:module_reports(fw, batt_pct, power_source, wifi_ssid, wifi_rssi)")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .returns<DeviceRow[]>();
  if (devices.error) throw devices.error;

  return Promise.all(
    devices.data.map(async ({ id, name, latitude, longitude, last_seen_at, report }) => {
      const readings = await supabase
        .from("module_readings")
        .select("ts, temp_c, hum_pct, pressure_hpa, iaq, lux")
        .eq("device_id", id)
        .order("ts", { ascending: false })
        .limit(30);
      if (readings.error) throw readings.error;
      return {
        id,
        name,
        latitude,
        longitude,
        fw: report?.fw ?? null,
        batt_pct: report?.batt_pct ?? null,
        power_source: report?.power_source ?? null,
        wifi_ssid: report?.wifi_ssid ?? null,
        wifi_rssi: report?.wifi_rssi ?? null,
        last_seen: last_seen_at ? ms(last_seen_at) : null,
        latest: latestReading(readings.data as ReadingRow[]),
      };
    }),
  );
}

/** Everything the dashboard shows, for one time range and module. Callers must be authenticated (secret-key client). */
export async function getDashboardData(range: RangeKey, moduleId?: string): Promise<DashboardData> {
  const now = Date.now();
  const { spanS, bucketS } = RANGES[range];
  const bucketMs = bucketS * 1000;
  // Align to the bucket grid so buckets stay stable between refreshes.
  const from = Math.floor((now - spanS * 1000) / bucketMs) * bucketMs;
  const fromIso = new Date(from).toISOString();
  const interval = `${bucketS} seconds`;

  const modules = await getModules();
  const selected = modules.find((m) => m.id === moduleId) ?? modules[0] ?? null;

  const [moduleSeries, usageSeries, latestUsage, snapshot, eventsKeys] = await Promise.all([
    selected ? supabase.rpc("module_series", { p_from: fromIso, p_bucket: interval, p_device: selected.id }) : { data: [], error: null },
    supabase.rpc("usage_series", { p_from: fromIso, p_bucket: interval }),
    Promise.all(
      USAGE_TOOLS.map((name) =>
        supabase
          .from("usage_states")
          .select("name, measured_at, session_pct, session_resets_at, week_pct, week_resets_at, month_pct, month_resets_at")
          .eq("name", name)
          .order("measured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    supabase.from("event_snapshots").select("events, received_at").order("received_at", { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("scope", "events")
      .is("revoked_at", null)
      .gt("expires_at", new Date(now).toISOString()),
  ]);
  for (const r of [moduleSeries, usageSeries, snapshot, eventsKeys, ...latestUsage]) if (r.error) throw r.error;

  const grid = buckets(from, now, bucketMs);

  const moduleByT = new Map(((moduleSeries.data ?? []) as ModuleBucketRow[]).map((r) => [ms(r.bucket), r]));
  const moduleSeriesFilled: ModulePoint[] = grid.map((t) => {
    const r = moduleByT.get(t);
    return {
      t,
      temp_c: round(r?.temp_c ?? null, 1),
      hum_pct: round(r?.hum_pct ?? null, 1),
      pressure_hpa: round(r?.pressure_hpa ?? null, 1),
      iaq: round(r?.iaq ?? null, 0),
      lux: round(r?.lux ?? null, 0),
    };
  });

  const usageByKey = new Map(((usageSeries.data ?? []) as UsageBucketRow[]).map((r) => [`${r.name}:${ms(r.bucket)}`, r]));
  const usage = USAGE_TOOLS.map((tool, i) => {
    const u = latestUsage[i].data;
    const sessionResetsAt = u?.session_resets_at ? ms(u.session_resets_at) : null;
    const sessionOver = sessionResetsAt === null || sessionResetsAt <= now;
    return {
      tool,
      series: grid.map((t) => {
        const r = usageByKey.get(`${tool}:${t}`);
        return { t, session_pct: round(r?.session_pct ?? null, 1), week_pct: round(r?.week_pct ?? null, 1), month_pct: round(r?.month_pct ?? null, 1) };
      }),
      latest: u
        ? {
            name: tool,
            measured_at: ms(u.measured_at),
            session_pct: u.session_pct === null ? null : sessionOver ? 0 : u.session_pct,
            session_resets_at: sessionOver ? null : sessionResetsAt,
            week_pct: u.week_pct,
            week_resets_at: u.week_resets_at ? ms(u.week_resets_at) : null,
            month_pct: u.month_pct,
            month_resets_at: u.month_resets_at ? ms(u.month_resets_at) : null,
          }
        : null,
    };
  });

  // Upcoming only; the snapshot is already sorted by start.
  const events = ((snapshot.data?.events ?? []) as StoredEvent[])
    .map((e) => ({ id: e.id, title: e.title, start: ms(e.starts_at), end: ms(e.ends_at) }))
    .filter((e) => e.end > now);

  return {
    range,
    from,
    now,
    modules,
    selected: selected && { module: selected, series: moduleSeriesFilled },
    usage,
    events,
    eventsSyncedAt: snapshot.data ? ms(snapshot.data.received_at) : null,
    eventsKeyActive: (eventsKeys.count ?? 0) > 0,
  };
}
