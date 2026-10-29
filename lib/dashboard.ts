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
export type ModulePoint = { t: number; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null };
export type UsagePoint = { t: number; session_pct: number | null; week_pct: number | null };

export type ModuleLatest = {
  temp_c: number | null;
  hum_pct: number | null;
  pressure_hpa: number | null;
  iaq: number | null;
  /** When the newest reading was taken (epoch ms). */
  ts: number;
};

export type DeviceStatus = {
  device_id: string;
  fw: string | null;
  batt_pct: number | null;
  power_source: string | null;
  wifi_rssi: number | null;
  received_at: number;
};

export type UsageLatest = {
  name: UsageTool;
  measured_at: number;
  /** 0 once the session has reset. */
  session_pct: number;
  session_resets_at: number | null;
  week_pct: number;
  week_resets_at: number;
};

export type DashboardEvent = { id: string | null; title: string; start: number; end: number };

export type DashboardData = {
  range: RangeKey;
  from: number;
  now: number;
  module: { series: ModulePoint[]; latest: ModuleLatest | null; device: DeviceStatus | null };
  usage: { tool: UsageTool; series: UsagePoint[]; latest: UsageLatest | null }[];
  events: DashboardEvent[];
};

type StoredEvent = { id: string | null; title: string; starts_at: string; ends_at: string };
type ModuleBucketRow = { bucket: string; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null };
type UsageBucketRow = { bucket: string; name: UsageTool; session_pct: number; week_pct: number };
type ReadingRow = { ts: string; temp_c: number | null; hum_pct: number | null; pressure_hpa: number | null; iaq: number | null };

const ms = (iso: string) => new Date(iso).getTime();
const round = (v: number | null, digits: number) => (v === null ? null : Number(v.toFixed(digits)));

// Every bucket start in [from, now], so missing data shows as a gap instead of a straight line across it.
function buckets(from: number, now: number, bucketMs: number) {
  const out: number[] = [];
  for (let t = from; t <= now; t += bucketMs) out.push(t);
  return out;
}

/** Everything the dashboard shows, for one time range. Callers must be authenticated (secret-key client). */
export async function getDashboardData(range: RangeKey): Promise<DashboardData> {
  const now = Date.now();
  const { spanS, bucketS } = RANGES[range];
  const bucketMs = bucketS * 1000;
  // Align to the bucket grid so buckets stay stable between refreshes.
  const from = Math.floor((now - spanS * 1000) / bucketMs) * bucketMs;
  const fromIso = new Date(from).toISOString();
  const interval = `${bucketS} seconds`;

  const [moduleSeries, usageSeries, readings, report, latestUsage, snapshot] = await Promise.all([
    supabase.rpc("module_series", { p_from: fromIso, p_bucket: interval }),
    supabase.rpc("usage_series", { p_from: fromIso, p_bucket: interval }),
    // A few recent rows: sensors report null while warming up, so take each field's newest non-null value.
    supabase
      .from("module_readings")
      .select("ts, temp_c, hum_pct, pressure_hpa, iaq")
      .order("ts", { ascending: false })
      .limit(30),
    supabase
      .from("module_reports")
      .select("device_id, fw, batt_pct, power_source, wifi_rssi, received_at")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.all(
      USAGE_TOOLS.map((name) =>
        supabase
          .from("usage_states")
          .select("name, measured_at, session_pct, session_resets_at, week_pct, week_resets_at")
          .eq("name", name)
          .order("measured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    supabase.from("event_snapshots").select("events").order("received_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [moduleSeries, usageSeries, readings, report, snapshot, ...latestUsage]) if (r.error) throw r.error;

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
    };
  });

  const rows = (readings.data ?? []) as ReadingRow[];
  const pick = (field: keyof Omit<ReadingRow, "ts">) => rows.find((r) => r[field] !== null)?.[field] ?? null;
  const latest: ModuleLatest | null = rows.length
    ? { temp_c: pick("temp_c"), hum_pct: pick("hum_pct"), pressure_hpa: pick("pressure_hpa"), iaq: pick("iaq"), ts: ms(rows[0].ts) }
    : null;

  const usageByKey = new Map(((usageSeries.data ?? []) as UsageBucketRow[]).map((r) => [`${r.name}:${ms(r.bucket)}`, r]));
  const usage = USAGE_TOOLS.map((tool, i) => {
    const u = latestUsage[i].data;
    const sessionResetsAt = u?.session_resets_at ? ms(u.session_resets_at) : null;
    const sessionOver = sessionResetsAt === null || sessionResetsAt <= now;
    return {
      tool,
      series: grid.map((t) => {
        const r = usageByKey.get(`${tool}:${t}`);
        return { t, session_pct: round(r?.session_pct ?? null, 1), week_pct: round(r?.week_pct ?? null, 1) };
      }),
      latest: u
        ? {
            name: tool,
            measured_at: ms(u.measured_at),
            session_pct: sessionOver ? 0 : u.session_pct,
            session_resets_at: sessionOver ? null : sessionResetsAt,
            week_pct: u.week_pct,
            week_resets_at: ms(u.week_resets_at),
          }
        : null,
    };
  });

  // Upcoming only; the snapshot is already sorted by start.
  const events = ((snapshot.data?.events ?? []) as StoredEvent[])
    .map((e) => ({ id: e.id, title: e.title, start: ms(e.starts_at), end: ms(e.ends_at) }))
    .filter((e) => e.end > now);

  const d = report.data;
  return {
    range,
    from,
    now,
    module: {
      series: moduleSeriesFilled,
      latest,
      device: d
        ? {
            device_id: d.device_id,
            fw: d.fw,
            batt_pct: d.batt_pct,
            power_source: d.power_source,
            wifi_rssi: d.wifi_rssi,
            received_at: ms(d.received_at),
          }
        : null,
    },
    usage,
    events,
  };
}
