"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { isAuthenticated } from "@/lib/auth/server";
import { supabase } from "@/lib/supabase/admin";

const locationInput = z.object({
  id: z.string().min(1).max(64),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Saves where a module sits on the dashboard map. */
export async function setModuleLocation(input: z.input<typeof locationInput>) {
  if (!(await isAuthenticated())) return { error: "Not allowed." };

  const parsed = locationInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid location." };

  const { id, latitude, longitude } = parsed.data;
  const { error } = await supabase.from("devices").update({ latitude, longitude }).eq("id", id);
  if (error) {
    console.error("[modules] location", error);
    return { error: "Could not save location." };
  }
  refresh();
}
