import { readRoute } from "@/lib/api/handler";
import { USAGE_TOOLS } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const unixOrNull = (iso: string | null) => (iso === null ? null : unix(iso));

type StoredEvent = { id: string | null; title: string; starts_at: string; ends_at: string };

// What the module renders on screen. Timestamps are Unix seconds, like the ingest APIs.
export const GET = readRoute("module", { limit: 10, windowS: 60, retryAfterS: 20 }, async () => {
  const [usage, snapshot] = await Promise.all([
    // Latest state per tool; tools that never reported are left out.
    Promise.all(
      USAGE_TOOLS.map((name) =>
        supabase
          .from("usage_states")
          .select("name, measured_at, session_pct, session_resets_at, week_pct, week_resets_at, month_pct, month_resets_at")
          .eq("name", name)
          .order("measured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    supabase.from("event_snapshots").select("events").order("received_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const usageStates = usage.map(({ data, error }) => {
    if (error) throw error;
    return data;
  });
  if (snapshot.error) throw snapshot.error;

  // Only events that haven't ended yet; the snapshot is already sorted by start.
  const now = Date.now();
  const events = ((snapshot.data?.events ?? []) as StoredEvent[])
    .filter((e) => new Date(e.ends_at).getTime() > now)
    .map((e) => ({ id: e.id, title: e.title, start: unix(e.starts_at), end: unix(e.ends_at) }));

  return {
    usage_states: usageStates
      .filter((u) => u !== null)
      .map((u) => ({
        name: u.name,
        measured_at: unix(u.measured_at),
        ...(u.name === "copilot"
          ? { month: { used_pct: u.month_pct, resets_at: unixOrNull(u.month_resets_at) } }
          : {
              session: { used_pct: u.session_pct, resets_at: unixOrNull(u.session_resets_at) },
              week: { used_pct: u.week_pct, resets_at: unix(u.week_resets_at) },
            }),
      })),
    events,
  };
});
