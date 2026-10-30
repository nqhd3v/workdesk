export type Meeting = {
  id: string;
  title: string;
  start: number; // unix seconds
  end: number; // unix seconds
};

/** Everything checkMeetings touches outside this file, so a day can be replayed in tests. */
export type CheckDeps = {
  now: number; // unix seconds
  cache: { get(key: string): string | null; put(key: string, value: string): void };
  // From now to the end of today, including a meeting already running.
  loadMeetings: () => Meeting[];
  pushEvents: (meetings: Meeting[]) => void;
};

export type CheckResult = "skipped" | "unchanged" | "synced";

const NEXT_CHECK = "nextCheck";
const MEETINGS = "meetings";
export const CACHE_KEYS = [NEXT_CHECK, MEETINGS];

/**
 * DEV_MODE's clock: 08:30 on the latest Thursday when `real` is after 12:00 or on a weekend,
 * otherwise `real` itself. On a Thursday afternoon that is the same day's 08:30.
 */
export function devDate(real: Date): Date {
  const day = real.getDay();
  if (day !== 0 && day !== 6 && real.getHours() < 12) return real;
  return new Date(real.getFullYear(), real.getMonth(), real.getDate() - ((day - 4 + 7) % 7), 8, 30);
}

/** Mon-Fri, 08:30-17:00. Triggers can't be limited to working hours, so the script gates itself. */
export function isWorkingTime(isoWeekday: number, hhmm: number): boolean {
  return isoWeekday <= 5 && hhmm >= 830 && hhmm <= 1700;
}

/**
 * Identifies the schedule from `now` on. Finished meetings don't count, so one ending is no change.
 * Time + title are included, so moving or renaming a meeting is seen as well as adding or removing one.
 */
export function fingerprint(meetings: Meeting[], now: number): string {
  const unfinished = meetings.filter((m) => m.end > now).sort((a, b) => a.start - b.start);
  return JSON.stringify(unfinished.map((m) => [m.id, m.start, m.end, m.title]));
}

export function runningMeetingEnd(meetings: Meeting[], now: number): number | null {
  return meetings.find((m) => m.start <= now && now < m.end)?.end ?? null;
}

export function runCheck({ now, cache, loadMeetings, pushEvents }: CheckDeps): CheckResult {
  const nextCheck = cache.get(NEXT_CHECK);
  if (nextCheck !== null && now < Number(nextCheck)) return "skipped";

  const meetings = loadMeetings();
  const saved = cache.get(MEETINGS);
  const changed = saved === null || fingerprint(JSON.parse(saved), now) !== fingerprint(meetings, now);

  // A throw here saves nothing, so the next run retries the push.
  if (changed) pushEvents(meetings);
  cache.put(MEETINGS, JSON.stringify(meetings));

  // No running meeting: leave nextCheck alone. A past value doesn't stop the next run.
  const end = runningMeetingEnd(meetings, now);
  if (end !== null) cache.put(NEXT_CHECK, String(end));
  return changed ? "synced" : "unchanged";
}
