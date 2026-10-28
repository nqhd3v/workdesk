import { ingestRoute } from "@/lib/api/handler";
import { usageStatePayload } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

const iso = (s: number) => new Date(s * 1000).toISOString();

export const POST = ingestRoute("usage_state", usageStatePayload, async (data, key) => {
  const { error } = await supabase.from("usage_states").insert({
    api_key_id: key.id,
    name: data.name,
    session_pct: data.session.used_pct,
    session_resets_at: data.session.resets_at === null ? null : iso(data.session.resets_at),
    week_pct: data.week.used_pct,
    week_resets_at: iso(data.week.resets_at),
    measured_at: iso(data.measured_at),
  });
  if (error) throw error;

  return {};
});
