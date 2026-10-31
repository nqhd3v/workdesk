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
          indicator="line"
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
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
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

/** Limit usage (%) over time for one tool, one line per window. Same unit, so one axis. */
export function UsageChart({
  data,
  windows,
  axis,
}: {
  data: { t: number; session_pct: number | null; week_pct: number | null; month_pct: number | null }[];
  windows: readonly (keyof typeof usageConfig)[];
  axis: TimeAxis;
}) {
  return (
    <ChartContainer config={usageConfig} className="aspect-auto h-44 w-full">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
        <Axes axis={axis} domain={[0, 100]} unit="%" />
        {tooltip(axis, "%", usageConfig)}
        <ChartLegend content={<ChartLegendContent />} verticalAlign="top" />
        {windows.map((key) => (
          <Line
            key={key}
            dataKey={key}
            type="linear"
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            connectNulls // reports are sparser than the buckets, so gaps are expected
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
