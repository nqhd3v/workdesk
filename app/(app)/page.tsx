import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CalendarBlankIcon, CellSignalHighIcon, BatteryMediumIcon, CheckCircleIcon, WarningIcon, WarningOctagonIcon } from "@phosphor-icons/react/dist/ssr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { MetricChart, UsageChart } from "@/components/dashboard/charts";
import { TIMEZONE } from "@/lib/api/time";
import { getDashboardData, parseRange, RANGES, type DashboardData, type ModuleLatest, type RangeKey, type UsageLatest } from "@/lib/dashboard";
import { cn } from "cn";

export const metadata: Metadata = { title: "Dashboard · Workdesk" };

// A module that hasn't reported for this long is shown as offline.
const STALE_MS = 15 * 60_000;

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
  const bucketLabel = `Average per ${formatDuration(RANGES[range].bucketS)}`;
  const { now } = data;
  const { latest, device, series } = data.module;
  const metric = (key: keyof Omit<ModuleLatest, "ts">) => series.map((p) => ({ t: p.t, value: p[key] }));

  return (
    <>
      <AutoRefresh />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker active={range} />
        <p className="text-xs text-muted-foreground">Updated {timeFormat.format(now)} · refreshes every minute</p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="env-heading">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="env-heading" className="font-heading text-sm font-medium">
            Environment
          </h2>
          <DeviceStatus device={device} now={now} />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Temperature" value={latest?.temp_c} unit="°C" digits={1} description={bucketLabel}>
            <MetricChart data={metric("temp_c")} label="Temperature" unit="°C" axis={axis} />
          </MetricCard>
          <MetricCard title="Humidity" value={latest?.hum_pct} unit="%" digits={0} description={bucketLabel}>
            <MetricChart data={metric("hum_pct")} label="Humidity" unit="%" axis={axis} />
          </MetricCard>
          <MetricCard title="Pressure" value={latest?.pressure_hpa} unit=" hPa" digits={0} description={bucketLabel}>
            <MetricChart data={metric("pressure_hpa")} label="Pressure" unit=" hPa" axis={axis} />
          </MetricCard>
          <MetricCard title="Air quality" value={latest?.iaq} unit=" IAQ" digits={0} description={iaqLabel(latest?.iaq)}>
            <MetricChart data={metric("iaq")} label="IAQ" unit="" axis={axis} domain={[0, "auto"]} />
          </MetricCard>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3" aria-label="Usage and events">
        {data.usage.map(({ tool, series, latest }) => (
          <UsageCard key={tool} tool={tool} latest={latest} now={now}>
            <UsageChart data={series} axis={axis} />
          </UsageCard>
        ))}
        <EventsCard events={data.events} now={now} />
      </section>
    </>
  );
}

// --- Formatting (server-side, fixed timezone, so hydration never depends on the browser) ---

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

function formatDuration(seconds: number) {
  if (seconds < 3600) return `${seconds / 60} min`;
  const h = seconds / 3600;
  return h === 1 ? "hour" : `${h} hours`;
}

/** "3 min ago", "in 2 hr", "in 4 days": the largest unit that fits. */
function fromNow(t: number, now: number) {
  const diffS = Math.round((t - now) / 1000);
  const abs = Math.abs(diffS);
  if (abs < 60) return diffS <= 0 ? "just now" : "in <1 min";
  if (abs < 3600) return relative.format(Math.trunc(diffS / 60), "minute");
  if (abs < 86_400) return relative.format(Math.trunc(diffS / 3600), "hour");
  return relative.format(Math.trunc(diffS / 86_400), "day");
}

function dayLabel(t: number, now: number) {
  const day = dayKey.format(t);
  if (day === dayKey.format(now)) return "Today";
  if (day === dayKey.format(now + 86_400_000)) return "Tomorrow";
  return dayFormat.format(t);
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

function DeviceStatus({ device, now }: { device: DashboardData["module"]["device"]; now: number }) {
  if (!device) return <span className="text-xs text-muted-foreground">No module has reported yet.</span>;
  const online = now - device.received_at < STALE_MS;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="outline" className="gap-1">
        {online ? <CheckCircleIcon weight="fill" className="text-status-good" /> : <WarningIcon weight="fill" className="text-status-warning" />}
        {online ? "Online" : "Offline"}
      </Badge>
      <span className="text-foreground">{device.device_id}</span>
      {device.fw && <span>fw {device.fw}</span>}
      {device.batt_pct !== null && (
        <span className="inline-flex items-center gap-1">
          <BatteryMediumIcon aria-hidden />
          {device.batt_pct}%{device.power_source ? ` · ${device.power_source}` : ""}
        </span>
      )}
      {device.wifi_rssi !== null && (
        <span className="inline-flex items-center gap-1">
          <CellSignalHighIcon aria-hidden />
          {device.wifi_rssi} dBm
        </span>
      )}
      <span>last report {fromNow(device.received_at, now)}</span>
    </div>
  );
}

function MetricCard({
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
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-muted-foreground">{title}</CardTitle>
        <div className="text-2xl font-semibold tabular-nums">
          {value == null ? "—" : value.toFixed(digits)}
          {value != null && <span className="text-sm font-normal text-muted-foreground">{unit}</span>}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-1">{children}</CardContent>
    </Card>
  );
}

const TOOL_NAMES: Record<string, string> = { claude: "Claude", copilot: "Copilot" };

function UsageCard({ tool, latest, now, children }: { tool: string; latest: UsageLatest | null; now: number; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{TOOL_NAMES[tool] ?? tool} usage</CardTitle>
        <CardDescription>{latest ? `Measured ${fromNow(latest.measured_at, now)}` : "Not reported yet"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {latest && (
          <>
            <Meter label="Session" pct={latest.session_pct} note={latest.session_resets_at ? `resets ${fromNow(latest.session_resets_at, now)}` : "no active session"} />
            <Meter label="Week" pct={latest.week_pct} note={`resets ${fromNow(latest.week_resets_at, now)}`} />
          </>
        )}
      </CardContent>
      <CardContent className="px-1">{children}</CardContent>
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

function EventsCard({ events, now }: { events: DashboardData["events"]; now: number }) {
  const shown = events.slice(0, 8);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Upcoming</CardTitle>
        <CardDescription>{events.length ? `${events.length} event${events.length === 1 ? "" : "s"}` : "Nothing scheduled"}</CardDescription>
        <CardAction>
          <CalendarBlankIcon className="text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent>
        {shown.length > 0 && (
          <ol className="flex flex-col divide-y">
            {shown.map((e, i) => {
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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-60" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-80" />
        ))}
      </div>
    </div>
  );
}
