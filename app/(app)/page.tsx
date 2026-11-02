import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CalendarBlankIcon, CellSignalHighIcon, BatteryMediumIcon, CheckCircleIcon, PlugsIcon, ThermometerIcon, WarningIcon, WarningOctagonIcon } from "@phosphor-icons/react/dist/ssr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ModuleMap } from "@/components/dashboard/module-map";
import { ModuleSelect, type ModuleOption } from "@/components/dashboard/module-select";
import { MetricChart, UsageChart, type TimeAxis } from "@/components/dashboard/charts";
import { TIMEZONE } from "@/lib/api/time";
import { MODULE_OFFLINE_AFTER_MS } from "@/lib/board";
import { getDashboardData, parseRange, RANGES, type DashboardData, type ModuleLatest, type ModuleStatus, type RangeKey, type UsageTool } from "@/lib/dashboard";
import { dayLabel, fromNow, timeFormat } from "@/lib/format";
import { cn } from "cn";

export const metadata: Metadata = { title: "Dashboard · Workdesk" };

const DAY_MS = 86_400_000;
const USAGE_SYNC_MAX_MS = 3_600_000;

// The calendar script doesn't run on weekends, so Sunday and Monday are still waiting on Friday's sync.
function eventsSyncMaxMs(now: number) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(now);
  return (weekday === "Sun" || weekday === "Mon" ? 3 : 1) * DAY_MS;
}

// Access is gated in proxy.ts (owner session required).
export default function DashboardPage({ searchParams }: PageProps<"/">) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Desk environment, plan usage, and what&apos;s coming up.</p>
      </div>
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Dashboard({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const { range: rangeParam, module: moduleParam } = await searchParams;
  const range = parseRange(rangeParam);
  await connection();

  let data: DashboardData;
  try {
    data = await getDashboardData(range, typeof moduleParam === "string" ? moduleParam : undefined);
  } catch (error) {
    console.error("[dashboard] load", error);
    const code = (error as { code?: string }).code;
    return <LoadError migrationMissing={code === "PGRST202" || code === "42703"} message={(error as Error).message} />;
  }

  const axis = { timeZone: TIMEZONE, multiDay: range !== "24h" };
  const { now, modules, selected } = data;
  const labels = moduleLabels(modules);

  return (
    <>
      <AutoRefresh intervalMs={15_000} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker active={range} moduleId={selected?.module.id} />
        <p className="text-xs text-muted-foreground">Updated {timeFormat.format(now)} · refreshes every 15s</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <EventsCard events={data.events} syncedAt={data.eventsSyncedAt} keyActive={data.eventsKeyActive} now={now} />
        <UsageCard usage={data.usage} axis={axis} now={now} className="lg:col-span-2" />
        <ModuleMap
          className="lg:col-span-3"
          modules={modules.map((m) => ({
            id: m.id,
            label: labels[m.id],
            online: isOnline(m, now),
            summary: moduleSummary(m, now),
            href: dashboardHref(range, m.id),
            selected: m.id === selected?.module.id,
            latitude: m.latitude,
            longitude: m.longitude,
          }))}
        />
        <ModuleCard
          selected={selected}
          options={modules.map((m) => ({ value: m.id, label: labels[m.id], href: dashboardHref(range, m.id) }))}
          axis={axis}
          bucketLabel={`Average per ${formatDuration(RANGES[range].bucketS)}`}
          now={now}
          className="lg:col-span-3"
        />
      </div>
    </>
  );
}

function dashboardHref(range: RangeKey, moduleId?: string) {
  const query = new URLSearchParams();
  if (range !== "24h") query.set("range", range);
  if (moduleId) query.set("module", moduleId);
  return query.size ? `/?${query}` : "/";
}

const isOnline = (m: ModuleStatus, now: number) => m.last_seen !== null && now - m.last_seen < MODULE_OFFLINE_AFTER_MS;

// Modules report the same default name, so the id tells those apart.
function moduleLabels(modules: ModuleStatus[]) {
  const shared = (name: string) => modules.filter((m) => m.name === name).length > 1;
  return Object.fromEntries(modules.map((m) => [m.id, !m.name ? m.id : shared(m.name) ? `${m.name} · ${m.id}` : m.name]));
}

/** One line for the map: whatever the module's sensors currently report. */
function moduleSummary(m: ModuleStatus, now: number) {
  if (!isOnline(m, now)) return "Offline";
  const parts = [
    m.latest?.temp_c != null && `${m.latest.temp_c.toFixed(1)}°C`,
    m.latest?.hum_pct != null && `${m.latest.hum_pct.toFixed(0)}%`,
    m.latest?.lux != null && `${m.latest.lux.toFixed(0)} lx`,
  ].filter(Boolean);
  return parts.join(" · ") || "No sensors";
}

function formatDuration(seconds: number) {
  if (seconds < 3600) return `${seconds / 60} min`;
  const h = seconds / 3600;
  return h === 1 ? "hour" : `${h} hours`;
}

// BME680-style IAQ bands.
function iaqLabel(iaq: number | null | undefined) {
  if (iaq == null) return "No reading yet";
  if (iaq <= 50) return "Excellent";
  if (iaq <= 100) return "Good";
  if (iaq <= 150) return "Lightly polluted";
  if (iaq <= 200) return "Moderately polluted";
  return "Heavily polluted";
}

// --- Pieces ---

function RangePicker({ active, moduleId }: { active: RangeKey; moduleId?: string }) {
  return (
    <nav aria-label="Time range" className="flex">
      {(Object.keys(RANGES) as RangeKey[]).map((key) => (
        <Link
          key={key}
          href={dashboardHref(key, moduleId)}
          aria-current={key === active ? "page" : undefined}
          className={cn(buttonVariants({ variant: key === active ? "default" : "outline", size: "sm" }), "-ml-px first:ml-0")}
          scroll={false}
        >
          {key}
        </Link>
      ))}
    </nav>
  );
}

type Status = "online" | "offline" | "connected" | "disconnected";

const STATUS: Record<Status, { label: string; icon: React.ReactNode }> = {
  online: { label: "Online", icon: <CheckCircleIcon weight="fill" className="text-status-good" /> },
  offline: { label: "Offline", icon: <WarningOctagonIcon weight="fill" className="text-status-critical" /> },
  connected: { label: "Connected", icon: <CheckCircleIcon weight="fill" className="text-status-good" /> },
  disconnected: { label: "Disconnected", icon: <PlugsIcon weight="fill" /> },
};

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={cn("gap-1", status === "disconnected" && "text-muted-foreground")}>
      {STATUS[status].icon}
      {STATUS[status].label}
    </Badge>
  );
}

const METRICS: { key: keyof Omit<ModuleLatest, "ts">; title: string; unit: string; chartUnit: string; digits: number; domain?: [number | string, number | string] }[] = [
  { key: "temp_c", title: "Temperature", unit: "°C", chartUnit: "°C", digits: 1 },
  { key: "hum_pct", title: "Humidity", unit: "%", chartUnit: "%", digits: 0 },
  { key: "pressure_hpa", title: "Pressure", unit: " hPa", chartUnit: " hPa", digits: 0 },
  { key: "iaq", title: "Air quality", unit: " IAQ", chartUnit: "", digits: 0, domain: [0, "auto"] },
  { key: "lux", title: "Light", unit: " lx", chartUnit: " lx", digits: 0, domain: [0, "auto"] },
];

function ModuleCard({
  selected,
  options,
  axis,
  bucketLabel,
  now,
  className,
}: {
  selected: DashboardData["selected"];
  options: ModuleOption[];
  axis: TimeAxis;
  bucketLabel: string;
  now: number;
  className?: string;
}) {
  const device = selected?.module;
  const series = selected?.series ?? [];
  const metric = (key: keyof Omit<ModuleLatest, "ts">) => series.map((p) => ({ t: p.t, value: p[key] }));
  const online = !!device && isOnline(device, now);
  // Offline, the last values aren't current, so only the charts' history stays.
  const current = online ? device.latest : null;
  // Each sensor is optional: a metric shows once it has data to show.
  const metrics = METRICS.filter(({ key }) => current?.[key] != null || series.some((p) => p[key] !== null));
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>IoT module</CardTitle>
        <CardDescription>{device ? (device.last_seen === null ? "No report yet" : `Last report ${fromNow(device.last_seen, now)}`) : "No module has reported yet"}</CardDescription>
        {device && (
          <CardAction className="flex items-center gap-2">
            <StatusBadge status={online ? "online" : "offline"} />
            <ModuleSelect options={options} value={device.id} />
          </CardAction>
        )}
      </CardHeader>
      {online && (
        <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {device.fw && <span>fw {device.fw}</span>}
          {device.batt_pct !== null && (
            <span className="inline-flex items-center gap-1">
              <BatteryMediumIcon aria-hidden />
              {device.batt_pct}%{device.power_source ? ` · ${device.power_source}` : ""}
            </span>
          )}
          {(device.wifi_ssid !== null || device.wifi_rssi !== null) && (
            <span className="inline-flex items-center gap-1">
              <CellSignalHighIcon aria-hidden />
              {[device.wifi_ssid, device.wifi_rssi !== null && `${device.wifi_rssi} dBm`].filter(Boolean).join(" · ")}
            </span>
          )}
        </CardContent>
      )}
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ key, title, unit, chartUnit, digits, domain }) => (
          <Metric key={key} title={title} value={current?.[key]} unit={unit} digits={digits} description={key === "iaq" && online ? iaqLabel(current?.iaq) : bucketLabel}>
            <MetricChart data={metric(key)} label={title} unit={chartUnit} axis={axis} domain={domain} />
          </Metric>
        ))}
        {metrics.length === 0 && (
          <Empty className="md:col-span-2 xl:col-span-4">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="text-muted-foreground">
                <ThermometerIcon />
              </EmptyMedia>
              <EmptyTitle className="font-normal text-muted-foreground">No sensors connected</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  title,
  value,
  unit,
  digits,
  description,
  children,
}: {
  title: string;
  value: number | null | undefined;
  unit: string;
  digits: number;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground">{title}</div>
      <div className="text-2xl font-semibold tabular-nums">
        {value == null ? "—" : value.toFixed(digits)}
        {value != null && <span className="text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      <div className="text-muted-foreground">{description}</div>
      {children}
    </div>
  );
}

const TOOL_NAMES: Record<UsageTool, string> = { claude: "Claude", copilot: "Copilot" };
const TOOL_WINDOWS = { claude: ["session_pct", "week_pct"], copilot: ["month_pct"] } as const;

function UsageCard({ usage, axis, now, className }: { usage: DashboardData["usage"]; axis: TimeAxis; now: number; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>AI usage</CardTitle>
        <CardDescription>Plan limits per tool</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        {usage.map(({ tool, series, latest }) => (
          <div key={tool} className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-medium">{TOOL_NAMES[tool]}</div>
                <div className="text-muted-foreground">{latest ? `Synced ${fromNow(latest.measured_at, now)}` : "Not synced yet"}</div>
              </div>
              {(!latest || now - latest.measured_at > USAGE_SYNC_MAX_MS) && <StatusBadge status="disconnected" />}
            </div>
            {latest?.session_pct != null && <Meter label="Session" pct={latest.session_pct} note={latest.session_resets_at ? `resets ${fromNow(latest.session_resets_at, now)}` : "no active session"} />}
            {latest?.week_pct != null && latest.week_resets_at && <Meter label="Week" pct={latest.week_pct} note={`resets ${fromNow(latest.week_resets_at, now)}`} fill="bg-chart-2" />}
            {latest?.month_pct != null && latest.month_resets_at && <Meter label="Month" pct={latest.month_pct} note={`resets ${fromNow(latest.month_resets_at, now)}`} />}
            <UsageChart data={series} windows={TOOL_WINDOWS[tool]} axis={axis} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Usage meter. `fill` matches the window's chart line; past the warning line, severity replaces it and adds an icon + label. */
function Meter({ label, pct, note, fill = "bg-chart-1" }: { label: string; pct: number; note: string; fill?: string }) {
  const level = pct >= 90 ? "critical" : pct >= 75 ? "warning" : "ok";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1">
          {label}
          {level === "critical" && (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <WarningOctagonIcon weight="fill" className="text-status-critical" /> at limit
            </span>
          )}
          {level === "warning" && (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <WarningIcon weight="fill" className="text-status-warning" /> near limit
            </span>
          )}
        </span>
        <span className="text-muted-foreground">
          <span className="font-medium tabular-nums text-foreground">{Math.round(pct)}%</span> · {note}
        </span>
      </div>
      <div className="h-1.5 w-full bg-muted" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div
          className={cn("h-full", level === "critical" ? "bg-status-critical" : level === "warning" ? "bg-status-warning" : fill)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function EventsCard({ events, syncedAt, keyActive, now }: { events: DashboardData["events"]; syncedAt: number | null; keyActive: boolean; now: number }) {
  // Set up but never synced: the first sync is still to come, so nothing is wrong yet.
  const waiting = syncedAt === null && keyActive;
  const disconnected = syncedAt === null ? !keyActive : now - syncedAt > eventsSyncMaxMs(now);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>
          {syncedAt !== null ? `Synced ${fromNow(syncedAt, now)}` : waiting ? "Waiting for first sync" : "Not set up"}
          {events.length > 0 && ` · ${events.length} upcoming`}
        </CardDescription>
        {(waiting || disconnected) && (
          <CardAction>
            <StatusBadge status={waiting ? "connected" : "disconnected"} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {events.length === 0 && !disconnected && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon" className="text-muted-foreground">
                <CalendarBlankIcon />
              </EmptyMedia>
              <EmptyTitle className="font-normal text-muted-foreground">No meetings today</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {events.length > 0 && (
          <ol className="flex max-h-96 flex-col divide-y overflow-y-auto">
            {events.map((e, i) => {
              const live = e.start <= now;
              return (
                <li key={e.id ?? i} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="w-20 shrink-0 text-muted-foreground tabular-nums">
                    <div>{dayLabel(e.start, now)}</div>
                    <div>
                      {timeFormat.format(e.start)}–{timeFormat.format(e.end)}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium" title={e.title}>
                      {e.title}
                    </span>
                    <span className="text-muted-foreground">{live ? `Now · ends ${fromNow(e.end, now)}` : fromNow(e.start, now)}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function LoadError({ migrationMissing, message }: { migrationMissing: boolean; message?: string }) {
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>{migrationMissing ? "Database not up to date" : "Could not load dashboard"}</AlertTitle>
      <AlertDescription>
        {migrationMissing ? (
          <>
            Apply the newest files in <code>supabase/migrations</code> to your Supabase project, then reload.
          </>
        ) : (
          message
        )}
      </AlertDescription>
    </Alert>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label="Loading">
      <Skeleton className="h-7 w-32" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-96" />
        <Skeleton className="h-96 lg:col-span-2" />
        <Skeleton className="h-96 lg:col-span-3" />
        <Skeleton className="h-80 lg:col-span-3" />
      </div>
    </div>
  );
}
