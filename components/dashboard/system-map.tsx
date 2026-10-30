// Dashboard version of the login illustration: every data source around the Workdesk hub, with live
// details. Same parts and intro, but each card's LED and traffic follow that source's real status.
// Rendered on the server; AutoRefresh keeps the values current.

import { connectStyle, Database, Droplet, GridBackdrop, ProgressBar, Traffic } from "@/components/system/parts";
import { MODULE_OFFLINE_AFTER_MS } from "@/lib/board";
import type { DashboardData, UsageLatest } from "@/lib/dashboard";
import { dayLabel, fromNow, timeFormat } from "@/lib/format";

type Status = "online" | "idle" | "offline";

const WIDTH = 1080;
const HEIGHT = 420;
const CARD = { width: 280, height: 160 };

// The usage sender stops at night and on weekends, so a quiet one is idle rather than broken.
const USAGE_ONLINE_MS = 30 * 60_000;
// The calendar script only sends changes, but always syncs on a weekday's first run: Fri to Mon is 3 days.
const CALENDAR_ONLINE_MS = 4 * 86_400_000;

const NODES = {
  module: { x: 24, y: 24, id: "map-module", d: "M 298 104 H 367 V 170 H 436", dur: 2.6, connect: 1.6 },
  calendar: { x: 24, y: 236, id: "map-calendar", d: "M 298 316 H 367 V 240 H 436", dur: 3.1, connect: 2.4 },
  claude: { x: 776, y: 24, id: "map-claude", d: "M 782 104 H 713 V 170 H 644", dur: 2.9, connect: 2 },
  copilot: { x: 776, y: 236, id: "map-copilot", d: "M 782 316 H 713 V 240 H 644", dur: 3.3, connect: 2.8 },
};

const STATUS_LABEL: Record<Status, string> = { online: "Online", idle: "Idle", offline: "Offline" };

const fmt = (value: number | null | undefined, digits = 0) => (value == null ? "—" : value.toFixed(digits));
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function usageStatus(latest: UsageLatest | null, now: number): Status {
  if (!latest) return "offline";
  return now - latest.measured_at < USAGE_ONLINE_MS ? "online" : "idle";
}

export function SystemMap({ data }: { data: DashboardData }) {
  const { now, events, eventsSyncedAt } = data;
  const { device, latest } = data.module;
  const claude = data.usage.find((u) => u.tool === "claude")?.latest ?? null;
  const copilot = data.usage.find((u) => u.tool === "copilot")?.latest ?? null;

  const statuses = {
    module: (device && now - device.received_at < MODULE_OFFLINE_AFTER_MS ? "online" : "offline") as Status,
    calendar: (eventsSyncedAt === null ? "offline" : now - eventsSyncedAt < CALENDAR_ONLINE_MS ? "online" : "idle") as Status,
    claude: usageStatus(claude, now),
    copilot: usageStatus(copilot, now),
  };
  const online = Object.values(statuses).filter((s) => s === "online").length;
  const summary = (Object.keys(statuses) as (keyof typeof statuses)[]).map((k) => `${k} ${STATUS_LABEL[statuses[k]].toLowerCase()}`);

  const moduleOnline = statuses.module === "online";
  const next = events[0];

  return (
    <svg role="img" aria-label={`System map: ${summary.join(", ")}.`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-auto w-full text-foreground">
      <GridBackdrop width={WIDTH} height={HEIGHT} />

      <Traffic id="map-db" d="M 540 94 V 136" dur={1.8} connect={0.8} />
      {(Object.keys(NODES) as (keyof typeof NODES)[]).map((key) => {
        const { id, d, dur, connect } = NODES[key];
        // Offline has no link at all; idle keeps the link but nothing moves on it.
        return statuses[key] !== "offline" && <Traffic key={id} id={id} d={d} dur={dur} connect={connect} packets={statuses[key] === "online"} />;
      })}

      <Database x={504} y={18} />
      <Hub online={online} total={Object.keys(NODES).length} updated={timeFormat.format(now)} />

      <StatusCard node={NODES.module} status={statuses.module} title={device?.name ?? device?.device_id ?? "Env module"} subtitle={[device?.fw && `fw ${device.fw}`, device?.wifi_ssid].filter(Boolean).join(" · ") || "Not reported yet"}>
        <text x="14" y="86" fontSize="22" className="fill-foreground font-semibold tabular-nums">
          {moduleOnline ? `${fmt(latest?.temp_c, 1)}°C` : "—"}
        </text>
        <Droplet x={132} y={72} />
        <text x="145" y="86" fontSize="16" className="fill-muted-foreground tabular-nums">
          {moduleOnline ? `${fmt(latest?.hum_pct)}%` : "—"}
        </text>
        <Line y={102} left="Air" right={moduleOnline ? `${fmt(latest?.pressure_hpa)} hPa · IAQ ${fmt(latest?.iaq)}` : "—"} />
        <Line y={116} left="Battery" right={device?.batt_pct == null ? "—" : `${device.batt_pct}%${device.power_source ? ` · ${device.power_source}` : ""}`} />
        <Line y={130} left="Wifi" right={device?.wifi_rssi == null ? "—" : `${device.wifi_rssi} dBm`} />
        <Line y={144} left="Last report" right={device ? fromNow(device.received_at, now) : "—"} />
      </StatusCard>

      <StatusCard node={NODES.calendar} status={statuses.calendar} title="Calendar" subtitle={`${events.length} upcoming`}>
        {next ? (
          <>
            <text x="14" y="82" fontSize="14" className="fill-foreground font-semibold">
              {truncate(next.title, 32)}
            </text>
            <Line y={104} left={next.start <= now ? "Now" : dayLabel(next.start, now)} right={`${timeFormat.format(next.start)}–${timeFormat.format(next.end)}`} />
            <Line y={118} left={next.start <= now ? "Ends" : "Starts"} right={fromNow(next.start <= now ? next.end : next.start, now)} />
          </>
        ) : (
          <text x="14" y="82" fontSize="13" className="fill-muted-foreground">
            Nothing scheduled
          </text>
        )}
        <Line y={144} left="Last sync" right={eventsSyncedAt === null ? "—" : fromNow(eventsSyncedAt, now)} />
      </StatusCard>

      <UsageCard node={NODES.claude} status={statuses.claude} title="Claude" latest={claude} now={now} />
      <UsageCard node={NODES.copilot} status={statuses.copilot} title="Copilot" latest={copilot} now={now} />
    </svg>
  );
}

function StatusCard({
  node,
  status,
  title,
  subtitle,
  children,
}: {
  node: { x: number; y: number; connect: number };
  status: Status;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const led = status === "online" ? "sys-led fill-emerald-500" : status === "idle" ? "fill-amber-500" : "fill-red-500";
  return (
    <g transform={`translate(${node.x} ${node.y})`} style={connectStyle(node.connect)}>
      <rect width={CARD.width} height={CARD.height} rx="6" className="sys-border fill-card stroke-foreground/40" strokeWidth="1.25" />
      {/* chip */}
      <rect x="14" y="14" width="24" height="24" rx="4" className="fill-none stroke-foreground/50" strokeWidth="1.25" />
      <rect x="21" y="21" width="10" height="10" rx="1.5" className="fill-foreground/25" />
      <text x="48" y="25" fontSize="14" className="fill-foreground font-semibold">
        {truncate(title, 18)}
      </text>
      <text x="48" y="39" fontSize="11" className="fill-muted-foreground">
        {truncate(subtitle, 26)}
      </text>
      {/* status: the word keeps it readable without relying on the LED colour */}
      <text x="254" y="25" fontSize="11" textAnchor="end" className="fill-muted-foreground">
        {STATUS_LABEL[status]}
      </text>
      <circle cx="264" cy="21" r="4" className={led} />
      <g className="sys-online">{children}</g>
    </g>
  );
}

function UsageCard({ node, status, title, latest, now }: { node: { x: number; y: number; connect: number }; status: Status; title: string; latest: UsageLatest | null; now: number }) {
  return (
    <StatusCard node={node} status={status} title={title} subtitle="Plan usage">
      {latest ? (
        <>
          <UsageRow y={62} label="Session" pct={latest.session_pct} note={latest.session_resets_at ? `resets ${fromNow(latest.session_resets_at, now)}` : "no session"} />
          <UsageRow y={100} label="Week" pct={latest.week_pct} note={`resets ${fromNow(latest.week_resets_at, now)}`} />
        </>
      ) : (
        <text x="14" y="82" fontSize="13" className="fill-muted-foreground">
          Not reported yet
        </text>
      )}
      <Line y={144} left="Measured" right={latest ? fromNow(latest.measured_at, now) : "—"} />
    </StatusCard>
  );
}

function UsageRow({ y, label, pct, note }: { y: number; label: string; pct: number; note: string }) {
  return (
    <g transform={`translate(0 ${y})`}>
      <text x="14" y="10" fontSize="12" className="fill-foreground">
        {label}
      </text>
      <text x="266" y="10" fontSize="12" textAnchor="end" className="fill-muted-foreground tabular-nums">
        {Math.round(pct)}% · {note}
      </text>
      <ProgressBar x={14} y={16} width={252} height={6} pct={pct} />
    </g>
  );
}

function Line({ y, left, right }: { y: number; left: string; right: string }) {
  return (
    <>
      <text x="14" y={y} fontSize="12" className="fill-muted-foreground">
        {left}
      </text>
      <text x="266" y={y} fontSize="12" textAnchor="end" className="fill-foreground tabular-nums">
        {truncate(right, 24)}
      </text>
    </>
  );
}

function Hub({ online, total, updated }: { online: number; total: number; updated: string }) {
  return (
    <g transform="translate(430 130)">
      {/* stand */}
      <path d="M 96 150 L 90 174 H 130 L 124 150" className="fill-card stroke-foreground/40" strokeWidth="1.25" />
      <line x1="76" y1="174" x2="144" y2="174" className="stroke-foreground/40" strokeWidth="1.25" />
      {/* bezel */}
      <rect width="220" height="150" rx="6" className="fill-card stroke-foreground/50" strokeWidth="1.5" />
      <rect x="10" y="10" width="200" height="130" rx="3" className="fill-muted" />
      <text x="110" y="52" fontSize="15" textAnchor="middle" className="fill-foreground font-semibold">
        Workdesk
      </text>
      <text x="110" y="88" fontSize="26" textAnchor="middle" className="fill-foreground font-semibold tabular-nums">
        {online}/{total}
      </text>
      <text x="110" y="106" fontSize="11" textAnchor="middle" className="fill-muted-foreground">
        sources online
      </text>
      <text x="110" y="126" fontSize="11" textAnchor="middle" className="fill-muted-foreground tabular-nums">
        Updated {updated}
      </text>
    </g>
  );
}
