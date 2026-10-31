import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CellSignalHighIcon, BatteryMediumIcon, CheckCircleIcon, WarningIcon, WarningOctagonIcon } from "@phosphor-icons/react/dist/ssr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { MetricChart, UsageChart, type TimeAxis } from "@/components/dashboard/charts";
import { TIMEZONE } from "@/lib/api/time";
import { MODULE_OFFLINE_AFTER_MS } from "@/lib/board";
import { getDashboardData, parseRange, RANGES, type DashboardData, type ModuleLatest, type RangeKey, type UsageTool } from "@/lib/dashboard";
import { dayLabel, fromNow, timeFormat } from "@/lib/format";
import { cn } from "cn";

export const metadata: Metadata = { title: "Dashboard · Workdesk" };

// The usage sender stops at night and on weekends, so a quiet one is idle rather than broken.
const USAGE_ONLINE_MS = 30 * 60_000;
// The calendar script only sends changes, but always syncs on a weekday's first run: Fri to Mon is 3 days.
const CALENDAR_ONLINE_MS = 4 * 86_400_000;

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
  const range = parseRange((await searchParams).range);
  await connection();

  let data: DashboardData;
  try {
    data = await getDashboardData(range);
  } catch (error) {
    console.error("[dashboard] load", error);
    const code = (error as { code?: string }).code;
    return <LoadError missingFunction={code === "PGRST202"} message={(error as Error).message} />;
  }

  const axis = { timeZone: TIMEZONE, multiDay: range !== "24h" };
  const { now } = data;

  return (
    <>
      <AutoRefresh />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker active={range} />
        <p className="text-xs text-muted-foreground">Updated {timeFormat.format(now)} · refreshes every 30s</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <EventsCard events={data.events} syncedAt={data.eventsSyncedAt} now={now} />
        <UsageCard usage={data.usage} axis={axis} now={now} className="lg:col-span-2" />
        <ModuleCard module={data.module} axis={axis} bucketLabel={`Average per ${formatDuration(RANGES[range].bucketS)}`} now={now} className="lg:col-span-3" />
      </div>
    </>
  );
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

function RangePicker({ active }: { active: RangeKey }) {
  return (
    <nav aria-label="Time range" className="flex">
      {(Object.keys(RANGES) as RangeKey[]).map((key) => (
        <Link
          key={key}
          href={key === "24h" ? "/" : `/?range=${key}`}
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

type Status = "online" | "idle" | "offline";

const STATUS: Record<Status, { label: string; icon: React.ReactNode }> = {
  online: { label: "Online", icon: <CheckCircleIcon weight="fill" className="text-status-good" /> },
  idle: { label: "Idle", icon: <WarningIcon weight="fill" className="text-status-warning" /> },
  offline: { label: "Offline", icon: <WarningOctagonIcon weight="fill" className="text-status-critical" /> },
};

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className="gap-1">
      {STATUS[status].icon}
      {STATUS[status].label}
    </Badge>
  );
}

function ModuleCard({
  module: { device, latest, series },
  axis,
  bucketLabel,
  now,
  className,
}: {
  module: DashboardData["module"];
  axis: TimeAxis;
  bucketLabel: string;
  now: number;
  className?: string;
}) {
  const metric = (key: keyof Omit<ModuleLatest, "ts">) => series.map((p) => ({ t: p.t, value: p[key] }));
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>IoT module</CardTitle>
        <CardDescription>{device ? (device.name ?? device.device_id) : "No module has reported yet"}</CardDescription>
        <CardAction>
          <StatusBadge status={device && now - device.received_at < MODULE_OFFLINE_AFTER_MS ? "online" : "offline"} />
        </CardAction>
      </CardHeader>
      {device && (
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
          <span>Last report {fromNow(device.received_at, now)}</span>
        </CardContent>
      )}
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric title="Temperature" value={latest?.temp_c} unit="°C" digits={1} description={bucketLabel}>
          <MetricChart data={metric("temp_c")} label="Temperature" unit="°C" axis={axis} />
        </Metric>
        <Metric title="Humidity" value={latest?.hum_pct} unit="%" digits={0} description={bucketLabel}>
          <MetricChart data={metric("hum_pct")} label="Humidity" unit="%" axis={axis} />
        </Metric>
        <Metric title="Pressure" value={latest?.pressure_hpa} unit=" hPa" digits={0} description={bucketLabel}>
          <MetricChart data={metric("pressure_hpa")} label="Pressure" unit=" hPa" axis={axis} />
        </Metric>
        <Metric title="Air quality" value={latest?.iaq} unit=" IAQ" digits={0} description={iaqLabel(latest?.iaq)}>
          <MetricChart data={metric("iaq")} label="IAQ" unit="" axis={axis} domain={[0, "auto"]} />
        </Metric>
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
                <div className="text-muted-foreground">{latest ? `Measured ${fromNow(latest.measured_at, now)}` : "Not reported yet"}</div>
              </div>
              <StatusBadge status={!latest ? "offline" : now - latest.measured_at < USAGE_ONLINE_MS ? "online" : "idle"} />
            </div>
            {latest?.session_pct != null && <Meter label="Session" pct={latest.session_pct} note={latest.session_resets_at ? `resets ${fromNow(latest.session_resets_at, now)}` : "no active session"} />}
            {latest?.week_pct != null && latest.week_resets_at && <Meter label="Week" pct={latest.week_pct} note={`resets ${fromNow(latest.week_resets_at, now)}`} />}
            {latest?.month_pct != null && latest.month_resets_at && <Meter label="Month" pct={latest.month_pct} note={`resets ${fromNow(latest.month_resets_at, now)}`} />}
            <UsageChart data={series} windows={TOOL_WINDOWS[tool]} axis={axis} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Usage meter. Severity shows in the fill and, past the warning line, an icon + label. */
function Meter({ label, pct, note }: { label: string; pct: number; note: string }) {
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
          className={cn("h-full", level === "critical" ? "bg-status-critical" : level === "warning" ? "bg-status-warning" : "bg-chart-1")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function EventsCard({ events, syncedAt, now }: { events: DashboardData["events"]; syncedAt: number | null; now: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>
          {events.length ? `${events.length} upcoming` : "Nothing scheduled"} · {syncedAt === null ? "not synced yet" : `synced ${fromNow(syncedAt, now)}`}
        </CardDescription>
        <CardAction>
          <StatusBadge status={syncedAt === null ? "offline" : now - syncedAt < CALENDAR_ONLINE_MS ? "online" : "idle"} />
        </CardAction>
      </CardHeader>
      <CardContent>
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

function LoadError({ missingFunction, message }: { missingFunction: boolean; message?: string }) {
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>{missingFunction ? "Database not up to date" : "Could not load dashboard"}</AlertTitle>
      <AlertDescription>
        {missingFunction ? (
          <>
            Apply <code>supabase/migrations/20261029050000_dashboard_series.sql</code> to your Supabase project, then reload.
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
        <Skeleton className="h-80 lg:col-span-3" />
      </div>
    </div>
  );
}
