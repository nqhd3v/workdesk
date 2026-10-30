import { CACHE_KEYS, devDate, isWorkingTime, runCheck, type Meeting } from "./check";

// Testing only: runs against a past Thursday morning outside working hours, see devDate(). Every run
// checks and sends, and it replaces Workdesk's real event list. Keep this false on main.
const DEV_MODE = false;

const CACHE_TTL_S = 21_600; // CacheService's maximum, 6 hours. Losing a value only costs one extra check.
const NO_TITLE = "(No title)";
const MAX_TITLE = 200; // /api/events limit

const secs = (d: GoogleAppsScript.Base.Date) => Math.floor(d.getTime() / 1000);

function property(name: string): string {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`Script property ${name} is not set`);
  return value;
}

function loadRemaining(now: Date): Meeting[] {
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return CalendarApp.getDefaultCalendar()
    .getEvents(now, endOfDay)
    // All-day events would hold nextCheck until midnight.
    .filter((e) => !e.isAllDayEvent() && e.getMyStatus() !== CalendarApp.GuestStatus.NO)
    .map((e) => ({
      id: e.getId(),
      title: (e.getTitle() || NO_TITLE).slice(0, MAX_TITLE),
      start: secs(e.getStartTime()),
      end: secs(e.getEndTime()),
    }));
}

// POST /api/events replaces the stored list, so it always gets everything left today. See docs/api.md.
function pushEvents(meetings: Meeting[], now: number) {
  const res = UrlFetchApp.fetch(`${property("WORKDESK_URL").replace(/\/$/, "")}/api/events`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-workdesk-key": property("WORKDESK_KEY") },
    payload: JSON.stringify({ sent_at: now, events: meetings }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 201) {
    throw new Error(`/api/events returned ${res.getResponseCode()}: ${res.getContentText()}`);
  }
}

/** Trigger entry point. */
export function checkMeetings() {
  const date = DEV_MODE ? devDate(new Date()) : new Date();
  const zone = Session.getScriptTimeZone();
  const isoWeekday = Number(Utilities.formatDate(date, zone, "u"));
  const hhmm = Number(Utilities.formatDate(date, zone, "HHmm"));
  if (!isWorkingTime(isoWeekday, hhmm)) return;

  const now = Math.floor(date.getTime() / 1000);
  const store = CacheService.getScriptCache();
  if (DEV_MODE) store.removeAll(CACHE_KEYS);
  const result = runCheck({
    now,
    cache: {
      get: (key) => store.get(key),
      put: (key, value) => store.put(key, value, CACHE_TTL_S),
    },
    loadMeetings: () => loadRemaining(date),
    pushEvents: (meetings) => pushEvents(meetings, now),
  });
  console.log(`checkMeetings: ${result}${DEV_MODE ? ` (DEV_MODE, as of ${date.toISOString()})` : ""}`);
}

/** Run once by hand after the first deploy. Safe to re-run: it replaces the existing trigger. */
export function installTrigger() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "checkMeetings") ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("checkMeetings").timeBased().everyMinutes(30).create();
}
