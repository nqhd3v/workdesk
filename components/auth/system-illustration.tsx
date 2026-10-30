"use client";

// Abstract system diagram for the auth card's right panel:
// two device cards exchange data with a dashboard screen, database behind it.
// Green dots = data up to the screen, blue squares = config back to devices.
// Intro: each device boots "connecting" (red blinking LED, wifi pulse, no border);
// once its --connect delay passes it goes green and its link/traffic/values appear.
// If the sensor module stops reporting, its LED stays red and its link/traffic/values go away.
// Values are live (polled from /verify/live): the sensor device and the screen's first row show
// temperature + humidity, the other device and the screen's second row show a usage bar.
// SVG + SMIL/CSS; motion is off for prefers-reduced-motion.

import { useEffect, useState } from "react";
import { connectStyle, Database, Droplet, GridBackdrop, ProgressBar, Traffic } from "@/components/system/parts";
import type { BoardData } from "@/lib/board";

const POLL_MS = 15_000;
const EMPTY: BoardData = { temp_c: null, hum_pct: null, usage_pct: null, sensor_online: null };

const DEVICES = [
  { id: "link-a", x: 20, y: 36, d: "M 70 86 V 182 H 110", dur: 2.6, connect: 1.6 },
  { id: "link-b", x: 240, y: 268, d: "M 290 274 V 214 H 250", dur: 3.1, connect: 2.4 },
];

const [SENSOR, USAGE] = DEVICES;

const fmtTemp = (v: number | null) => (v === null ? "--" : `${v.toFixed(1)}°C`);
const fmtPct = (v: number | null) => (v === null ? "--" : `${Math.round(v)}%`);

function useBoardData() {
  const [data, setData] = useState<BoardData>(EMPTY);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/verify/live", { cache: "no-store" });
        if (res.ok && alive) setData(await res.json());
      } catch {
        // Keep the last values; the next poll retries.
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return data;
}

export function SystemIllustration() {
  const data = useBoardData();
  const sensorOffline = data.sensor_online === false;
  return (
    <svg
      aria-hidden
      viewBox="0 0 360 360"
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 size-full text-foreground"
    >
      <GridBackdrop width={360} height={360} />

      {/* Connectors + traffic */}
      {DEVICES.map(({ id, d, dur, connect }) => !(sensorOffline && id === SENSOR.id) && (
        <Traffic key={id} id={id} d={d} dur={dur} connect={connect} />
      ))}

      <Database x={196} y={92} />
      <Screen x={104} y={132} data={data} />
      <DeviceCard x={SENSOR.x} y={SENSOR.y} connect={SENSOR.connect} offline={sensorOffline}>
        <text x="10" y="47" fontSize="11" className="fill-foreground font-semibold tabular-nums">
          {fmtTemp(data.temp_c)}
        </text>
        <Droplet x={66} y={39} />
        <text x="90" y="47" fontSize="9" textAnchor="end" className="fill-muted-foreground tabular-nums">
          {fmtPct(data.hum_pct)}
        </text>
      </DeviceCard>
      <DeviceCard x={USAGE.x} y={USAGE.y} connect={USAGE.connect}>
        <ProgressBar x={10} y={40} width={56} height={5} pct={data.usage_pct} />
        <text x="90" y="46" fontSize="9" textAnchor="end" className="fill-muted-foreground tabular-nums">
          {fmtPct(data.usage_pct)}
        </text>
      </DeviceCard>
    </svg>
  );
}

function DeviceCard({
  x,
  y,
  connect,
  offline = false,
  children,
}: {
  x: number;
  y: number;
  connect: number;
  offline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y})`} style={connectStyle(connect)}>
      <rect width="100" height="56" rx="6" className="sys-border fill-card stroke-foreground/40" strokeWidth="1.25" />
      {/* chip */}
      <rect x="10" y="12" width="18" height="18" rx="3" className="fill-none stroke-foreground/50" strokeWidth="1.25" />
      <rect x="15" y="17" width="8" height="8" rx="1" className="fill-foreground/25" />
      {/* label lines */}
      <rect x="36" y="14" width="28" height="4" rx="2" className="fill-foreground/30" />
      <rect x="36" y="24" width="20" height="4" rx="2" className="fill-foreground/15" />
      {/* wifi: pulses while connecting, settles once online */}
      <g className={`${offline ? "opacity-15" : "sys-wifi"} fill-none stroke-foreground/60`} strokeWidth="1.25" strokeLinecap="round">
        <circle cx="76" cy="20" r="0.9" className="fill-foreground/60 stroke-none" />
        <path d="M 73.5 17.5 A 3.5 3.5 0 0 1 78.5 17.5" />
        <path d="M 71.2 15.2 A 6.8 6.8 0 0 1 80.8 15.2" />
      </g>
      {/* status led: red + blinking while connecting, then green; solid red when offline */}
      <circle cx="88" cy="16" r="3" className={offline ? "fill-red-500" : "sys-led fill-emerald-500"} />
      {/* live values, shown once online */}
      <g className="sys-online">{children}</g>
    </g>
  );
}

function Screen({ x, y, data }: { x: number; y: number; data: BoardData }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* stand */}
      <path d="M 66 100 L 62 116 H 90 L 86 100" className="fill-card stroke-foreground/40" strokeWidth="1.25" />
      <line x1="52" y1="116" x2="100" y2="116" className="stroke-foreground/40" strokeWidth="1.25" />
      {/* bezel */}
      <rect width="152" height="100" rx="6" className="fill-card stroke-foreground/50" strokeWidth="1.5" />
      <rect x="8" y="8" width="136" height="84" rx="3" className="fill-muted" />

      {/* dashboard: header */}
      <circle cx="16" cy="16" r="2.5" className="fill-foreground/30" />
      <rect x="23" y="14" width="30" height="4" rx="2" className="fill-foreground/25" />

      {/* row 1: temperature + humidity tiles */}
      {[
        { dx: 14, value: fmtTemp(data.temp_c), droplet: false },
        { dx: 78, value: fmtPct(data.hum_pct), droplet: true },
      ].map(({ dx, value, droplet }) => (
        <g key={dx} transform={`translate(${dx} 26)`}>
          <rect width="60" height="24" rx="2" className="fill-card" />
          <rect x="5" y="5" width="16" height="3" rx="1.5" className="fill-foreground/20" />
          {droplet && <Droplet x={49} y={4} />}
          <g className="sys-online" style={connectStyle(SENSOR.connect)}>
            <text x="5" y="19" fontSize="9" className="fill-foreground font-semibold tabular-nums">
              {value}
            </text>
          </g>
        </g>
      ))}

      {/* row 2: usage bar */}
      <g transform="translate(14 56)">
        <rect width="124" height="30" rx="2" className="fill-card" />
        <rect x="6" y="7" width="28" height="3" rx="1.5" className="fill-foreground/20" />
        <g className="sys-online" style={connectStyle(USAGE.connect)}>
          <text x="118" y="11" fontSize="7" textAnchor="end" className="fill-muted-foreground tabular-nums">
            {fmtPct(data.usage_pct)}
          </text>
          <ProgressBar x={6} y={17} width={112} height={6} pct={data.usage_pct} />
        </g>
      </g>
    </g>
  );
}
