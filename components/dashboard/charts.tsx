"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export type TimeAxis = {
  /** IANA zone; formatting with a fixed zone keeps server and client output identical. */
  timeZone: string;
  /** Range is longer than a day: ticks show dates instead of times. */
  multiDay: boolean;
};

function timeFormatters({ timeZone, multiDay }: TimeAxis) {
  const tick = new Intl.DateTimeFormat("en-GB", multiDay ? { timeZone, day: "numeric", month: "short" } : { timeZone, hour: "2-digit", minute: "2-digit" });
  const full = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { tick: (t: number) => tick.format(t), full: (t: number) => full.format(t) };
}

// Shared axis chrome: hairline horizontal grid, no axis lines, muted ticks.
function Axes({ axis, domain, unit }: { axis: TimeAxis; domain: [number | string, number | string]; unit?: string }) {
  const fmt = timeFormatters(axis);
  return (
    <>
      <CartesianGrid vertical={false} strokeWidth={1} />
      <XAxis
        dataKey="t"
        type="number"
        scale="time"
        domain={["dataMin", "dataMax"]}
        tickFormatter={fmt.tick}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={48}
      />
      <YAxis
        domain={domain}
        tickLine={false}
        axisLine={false}
        width={40}
        tickMargin={4}
        tickCount={4}
        allowDecimals={false}
        tickFormatter={(v: number) => `${v}${unit ?? ""}`}
      />
    </>
  );
}

function tooltip(axis: TimeAxis, unit: string, chartConfig: ChartConfig) {
  const fmt = timeFormatters(axis);
  return (
    <ChartTooltip
      cursor={{ strokeWidth: 1 }}
      content={
        <ChartTooltipContent
          // "line" nests the label inside a single-series row, which the formatter below replaces.
          indicator="dot"
          labelFormatter={(_, payload) => fmt.full(payload[0]?.payload.t)}
          formatter={(value, name, item) => (
            <div className="flex w-full items-center gap-2">
              <span className="h-2.5 w-1 shrink-0" style={{ background: item.color }} />
              <span className="text-muted-foreground">{chartConfig[String(name)]?.label ?? name}</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">
                {value}
                {unit}
              </span>
            </div>
          )}
        />
      }
    />
  );
}

/** Single-series trend for one sensor metric. The card title names it, so no legend. */
export function MetricChart({
  data,
  label,
  unit,
  axis,
  domain = ["auto", "auto"],
}: {
  data: { t: number; value: number | null }[];
  label: string;
  unit: string;
  axis: TimeAxis;
  domain?: [number | string, number | string];
}) {
  const chartConfig = { value: { label, color: "var(--chart-1)" } } satisfies ChartConfig;
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-36 w-full">
      {/* Same syncId: hovering one sensor shows the same moment on the others. */}
      <AreaChart data={data} syncId="module-metrics" margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
        <Axes axis={axis} domain={domain} />
        {tooltip(axis, unit, chartConfig)}
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="var(--color-value)"
          fillOpacity={0.1}
          connectNulls={false}
          isAnimationActive={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

const usageConfig = {
  session_pct: { label: "Session", color: "var(--chart-1)" },
  week_pct: { label: "Week", color: "var(--chart-2)" },
  month_pct: { label: "Month", color: "var(--chart-1)" },
} satisfies ChartConfig;

type UsagePoint = { t: number; session_pct: number | null; week_pct: number | null; month_pct: number | null };
type UsageKey = keyof typeof usageConfig;

// Usage only climbs within a window, so a lower value belongs to the next one: a reset, not a decline.
const linked = (a: number | null | undefined, b: number | null | undefined) => !!a && !!b && b >= a;

// Line curve that lifts the pen instead of drawing downwards. SVG y grows towards the bottom.
const risingOnly: Extract<React.ComponentProps<typeof Line>["type"], (...args: never[]) => unknown> = (context) => {
  let prevY: number | undefined;
  return {
    areaStart() {},
    areaEnd() {},
    lineStart() {
      prevY = undefined;
    },
    lineEnd() {},
    point(x, y) {
      if (prevY === undefined || y > prevY) context.moveTo(x, y);
      else context.lineTo(x, y);
      prevY = y;
    },
  };
};

/**
 * 0% means the tool wasn't used, so it leaves a gap in the line. Reports are sparser than the buckets,
 * so empty buckets between two linked values are filled in a straight line instead of breaking it.
 */
function usageLine(data: UsagePoint[], key: UsageKey) {
  const values: (number | null)[] = data.map((p) => p[key]);
  values.forEach((value, i) => {
    if (value !== null) return;
    const prev = values[i - 1];
    const nextAt = values.findIndex((v, j) => j > i && v !== null);
    const next = values[nextAt];
    if (prev && next && linked(prev, next)) values[i] = Number((prev + (next - prev) / (nextAt - i + 1)).toFixed(1));
  });
  return values.map((value) => value || null);
}

/** Limit usage (%) over time for one tool, one line per window. Same unit, so one axis. */
export function UsageChart({
  data,
  windows,
  axis,
}: {
  data: UsagePoint[];
  windows: readonly UsageKey[];
  axis: TimeAxis;
}) {
  const lines = windows.map((key) => ({ key, values: usageLine(data, key) }));
  const rows = data.map((p, i) => ({ ...p, ...Object.fromEntries(lines.map(({ key, values }) => [key, values[i]])) }));
  return (
    <ChartContainer config={usageConfig} className="aspect-auto h-44 w-full">
      <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
        <Axes axis={axis} domain={[0, 100]} unit="%" />
        {tooltip(axis, "%", usageConfig)}
        <ChartLegend content={<ChartLegendContent />} verticalAlign="top" />
        {lines.map(({ key, values }) => (
          <Line
            key={key}
            dataKey={key}
            type={risingOnly}
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            connectNulls={false}
            isAnimationActive={false}
            // A value linked to neither neighbour draws no line, so it needs a dot to show at all.
            dot={({ key: dotKey, cx, cy, index }) => {
              const alone = values[index] !== null && !linked(values[index - 1], values[index]) && !linked(values[index], values[index + 1]);
              return <circle key={dotKey} cx={cx} cy={cy} r={alone ? 2 : 0} fill={`var(--color-${key})`} />;
            }}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
