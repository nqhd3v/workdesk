import { z } from "zod";

// All timestamps are Unix seconds (integers, UTC by definition).
const MIN_TS_S = 1_704_067_200; // 2024-01-01
const DAY_S = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);

/** Unix seconds after 2024-01-01 and at most `maxAheadS` in the future (default 1 day, for clock skew). */
const unixSeconds = (maxAheadS = DAY_S) =>
  z.int().refine((v) => v >= MIN_TS_S && v <= nowS() + maxAheadS, "Timestamp (unix seconds) out of range");
const percent = z.number().min(0).max(100);

// --- POST /api/module ----------------------------------------------------

export const modulePayload = z.object({
  v: z.literal(1),
  device: z.object({
    id: z.string().min(1).max(64),
    fw: z.string().max(32).optional(),
    uptime_s: z.int().nonnegative().optional(),
  }),
  power: z
    .object({
      source: z.string().max(16),
      batt_mv: z.int().nonnegative().nullable(),
      batt_pct: percent.nullable(),
    })
    .partial()
    .optional(),
  readings: z
    .array(
      z.object({
        ts: unixSeconds(),
        temp_c: z.number().min(-60).max(100).nullable(),
        hum_pct: percent.nullable(),
        pressure_hpa: z.number().min(300).max(1200).nullable(),
        gas_ohm: z.int().nonnegative().nullable(),
        iaq: z.number().min(0).max(500).nullable(),
        batt_mv: z.int().nonnegative().nullable(),
      }).partial({ temp_c: true, hum_pct: true, pressure_hpa: true, gas_ohm: true, iaq: true, batt_mv: true }),
    )
    .min(1)
    .max(1000),
  wifi: z
    .object({
      ssid: z.string().max(64),
      rssi: z.int().min(-127).max(0),
      ip: z.string().max(45),
    })
    .partial()
    .optional(),
});
export type ModulePayload = z.infer<typeof modulePayload>;

// --- POST /api/events ----------------------------------------------------

export const eventsPayload = z.object({
  sent_at: unixSeconds(),
  events: z
    .array(
      z
        .object({
          // Source id (e.g. calendar event id); optional, useful for later diffing.
          id: z.string().min(1).max(256).optional(),
          title: z.string().min(1).max(200),
          start: unixSeconds(366 * DAY_S),
          end: unixSeconds(367 * DAY_S),
        })
        .refine((e) => e.end >= e.start, { message: "end must be >= start", path: ["end"] })
        .refine((e) => e.end - e.start <= 7 * DAY_S, { message: "Event longer than 7 days", path: ["end"] }),
    )
    .max(100),
});
export type EventsPayload = z.infer<typeof eventsPayload>;

// --- POST /api/usage-state -----------------------------------------------

const usageWindow = z.object({
  used_pct: percent,
  // Absolute reset time; null when the window isn't running (e.g. no active session).
  resets_at: unixSeconds(30 * DAY_S).nullable(),
});

export const usageStatePayload = z.object({
  measured_at: unixSeconds(),
  session: usageWindow,
  week: usageWindow.extend({ resets_at: unixSeconds(30 * DAY_S) }),
});
export type UsageStatePayload = z.infer<typeof usageStatePayload>;
