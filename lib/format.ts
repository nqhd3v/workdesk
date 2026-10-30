import { TIMEZONE } from "@/lib/api/time";

// Fixed timezone, so server-rendered output never depends on the browser.
export const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** "3 min ago", "in 2 hr", "in 4 days": the largest unit that fits. */
export function fromNow(t: number, now: number) {
  const diffS = Math.round((t - now) / 1000);
  const abs = Math.abs(diffS);
  if (abs < 60) return diffS <= 0 ? "just now" : "in <1 min";
  if (abs < 3600) return relative.format(Math.trunc(diffS / 60), "minute");
  if (abs < 86_400) return relative.format(Math.trunc(diffS / 3600), "hour");
  return relative.format(Math.trunc(diffS / 86_400), "day");
}

export function dayLabel(t: number, now: number) {
  const day = dayKey.format(t);
  if (day === dayKey.format(now)) return "Today";
  if (day === dayKey.format(now + 86_400_000)) return "Tomorrow";
  return dayFormat.format(t);
}
