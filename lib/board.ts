import "server-only";
import { cacheLife } from "next/cache";
import { supabase } from "@/lib/supabase/admin";

/** Live values for the login board. Public: keep it to these few numbers. */
export type BoardData = {
  temp_c: number | null;
  hum_pct: number | null;
  // Current Claude session usage, 0 when no session is running.
  usage_pct: number | null;
  // Module reported recently. Null until known (client only, or the database is unreachable).
  sensor_online: boolean | null;
};

// Past this silence the module counts as disconnected. Modules post every minute, so this survives one
// lost post, and leaves 30s for a page to catch up: a status changes within 3 minutes everywhere.
export const MODULE_OFFLINE_AFTER_MS = 150_000;

// Shared by every visitor; caching keeps public polling off the database.
export async function getBoardData(): Promise<BoardData> {
  "use cache";
  cacheLife({ revalidate: 10, expire: 60 });

  const [report, reading, usage] = await Promise.all([
    // received_at, not reading ts: it comes from the server, device clocks can drift.
    supabase
      .from("module_reports")
      .select("received_at")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ received_at: string }>(),
    supabase
      .from("module_readings")
      .select("temp_c, hum_pct")
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle<{ temp_c: number | null; hum_pct: number | null }>(),
    supabase
      .from("usage_states")
      .select("session_pct, session_resets_at")
      .eq("name", "claude")
      .order("measured_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ session_pct: number; session_resets_at: string | null }>(),
  ]);
  if (report.error) throw report.error;
  if (reading.error) throw reading.error;
  if (usage.error) throw usage.error;

  const lastReport = report.data ? new Date(report.data.received_at).getTime() : 0;
  const sensorOnline = Date.now() - lastReport < MODULE_OFFLINE_AFTER_MS;

  const u = usage.data;
  const sessionOver = !u?.session_resets_at || new Date(u.session_resets_at).getTime() <= Date.now();
  return {
    temp_c: sensorOnline ? (reading.data?.temp_c ?? null) : null,
    hum_pct: sensorOnline ? (reading.data?.hum_pct ?? null) : null,
    usage_pct: u ? (sessionOver ? 0 : u.session_pct) : null,
    sensor_online: sensorOnline,
  };
}
