import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkingTime, runCheck, runningMeetingEnd, type Meeting } from "../src/check";

const at = (h: number, m = 0) => h * 3600 + m * 60;
const meeting = (id: string, start: number, end: number): Meeting => ({ id, title: id, start, end });

function setup(calendar: Meeting[]) {
  const store = new Map<string, string>();
  const pushes: string[][] = [];
  const check = (now: number) =>
    runCheck({
      now,
      cache: {
        get: (key) => store.get(key) ?? null,
        put: (key, value) => void store.set(key, value),
      },
      loadMeetings: () => calendar.filter((m) => m.end > now),
      pushEvents: (meetings) => void pushes.push(meetings.map((m) => m.id)),
    });
  return { store, pushes, check };
}

// The Thursday from docs/draft.md.
test("replays the sample day", () => {
  const calendar = [meeting("Crosscheck", at(9), at(9, 15)), meeting("Planning 1", at(9, 30), at(12))];
  const { store, pushes, check } = setup(calendar);
  const nextCheck = () => (store.has("nextCheck") ? Number(store.get("nextCheck")) : null);

  assert.equal(check(at(8, 30)), "synced");
  assert.equal(nextCheck(), null); // nothing running yet
  assert.equal(check(at(9)), "unchanged");
  assert.equal(nextCheck(), at(9, 15));
  assert.equal(check(at(9, 30)), "unchanged"); // Crosscheck finished, not a change
  assert.equal(nextCheck(), at(12));
  for (const m of [at(10), at(10, 30), at(11), at(11, 30)]) assert.equal(check(m), "skipped");
  assert.equal(check(at(12)), "unchanged");
  assert.equal(nextCheck(), at(12)); // left alone, and it doesn't block later runs

  calendar.push(meeting("Planning 2", at(13, 30), at(17, 30)));
  assert.equal(check(at(12, 30)), "synced");
  assert.equal(nextCheck(), at(12));
  assert.equal(check(at(13)), "unchanged");
  assert.equal(nextCheck(), at(12));
  assert.equal(check(at(13, 30)), "unchanged");
  assert.equal(nextCheck(), at(17, 30));
  for (const m of [at(14), at(15), at(16), at(17)]) assert.equal(check(m), "skipped");

  assert.deepEqual(pushes, [["Crosscheck", "Planning 1"], ["Planning 2"]]);
});

test("syncs a moved meeting with the same id", () => {
  const calendar = [meeting("a", at(14), at(15))];
  const { check } = setup(calendar);
  check(at(9));
  calendar[0] = meeting("a", at(14, 30), at(15, 30));
  assert.equal(check(at(9, 30)), "synced");
});

test("syncs a cancelled meeting, including the last one of the day", () => {
  const calendar = [meeting("a", at(14), at(15))];
  const { pushes, check } = setup(calendar);
  check(at(9));
  calendar.pop();
  assert.equal(check(at(9, 30)), "synced");
  assert.deepEqual(pushes[pushes.length - 1], []);
});

test("keeps nothing from a failed push, so the next run retries", () => {
  const { store } = setup([]);
  const deps = {
    cache: {
      get: (key: string) => store.get(key) ?? null,
      put: (key: string, value: string) => void store.set(key, value),
    },
    loadMeetings: () => [meeting("a", at(9), at(10))],
  };
  const fail = () => {
    throw new Error("502");
  };
  assert.throws(() => runCheck({ ...deps, now: at(8, 30), pushEvents: fail }));
  assert.equal(store.size, 0);
  assert.equal(runCheck({ ...deps, now: at(9), pushEvents: () => {} }), "synced");
});

test("checks again when the cache was evicted", () => {
  const { store, check } = setup([meeting("a", at(9), at(17))]);
  check(at(9));
  store.clear();
  assert.equal(check(at(10)), "synced");
});

test("runningMeetingEnd only sees a meeting in progress", () => {
  const meetings = [meeting("a", at(9), at(10)), meeting("b", at(12), at(13))];
  assert.equal(runningMeetingEnd(meetings, at(8, 59)), null);
  assert.equal(runningMeetingEnd(meetings, at(9)), at(10));
  assert.equal(runningMeetingEnd(meetings, at(10)), null);
  assert.equal(runningMeetingEnd(meetings, at(12, 30)), at(13));
});

test("isWorkingTime is Mon-Fri 08:30-17:00", () => {
  assert.equal(isWorkingTime(1, 829), false);
  assert.equal(isWorkingTime(1, 830), true);
  assert.equal(isWorkingTime(5, 1700), true);
  assert.equal(isWorkingTime(5, 1701), false);
  assert.equal(isWorkingTime(6, 1000), false);
  assert.equal(isWorkingTime(7, 1000), false);
});
