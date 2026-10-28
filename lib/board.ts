import "server-only";
import { cacheLife } from "next/cache";
import { supabase } from "@/lib/supabase/admin";

/** Live values for the login board. Public: keep it to these few numbers. */
export type BoardData = {
  temp_c: number | null;
  hum_pct: number | null;
  // Current Claude session usage, 0 when no session is running.
  usage_pct: number | null;
};

// Shared by every visitor; caching keeps public polling off the database.
export async function getBoardData(): Promise<BoardData> {
  "use cache";
  cacheLife({ revalidate: 15, expire: 60 });

  const [reading, usage] = await Promise.all([
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
  if (reading.error) throw reading.error;
  if (usage.error) throw usage.error;

  const u = usage.data;
  const sessionOver = !u?.session_resets_at || new Date(u.session_resets_at).getTime() <= Date.now();
  return {
    temp_c: reading.data?.temp_c ?? null,
    hum_pct: reading.data?.hum_pct ?? null,
    usage_pct: u ? (sessionOver ? 0 : u.session_pct) : null,
  };
}
