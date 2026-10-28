import { ingestRoute } from "@/lib/api/handler";
import { eventsPayload } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

const iso = (s: number) => new Date(s * 1000).toISOString();

export const POST = ingestRoute("events", eventsPayload, async (data, key) => {
  const events = data.events
    .map((e) => ({ id: e.id ?? null, title: e.title, starts_at: iso(e.start), ends_at: iso(e.end) }))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const { error } = await supabase.from("event_snapshots").insert({
    api_key_id: key.id,
    events,
    sent_at: iso(data.sent_at),
  });
  if (error) throw error;

  return { events: events.length };
});
