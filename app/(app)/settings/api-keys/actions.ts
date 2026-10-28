"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { generateKey } from "@/lib/api/keys";
import { API_SCOPES, MAX_KEY_LIFETIME_DAYS, type ApiScope } from "@/lib/api/scopes";
import { isAuthenticated } from "@/lib/auth/server";
import { supabase } from "@/lib/supabase/admin";

export type CreateKeyState =
  | { error: string }
  | { created: { key: string; name: string; scope: ApiScope; expires_at: string } }
  | undefined;

const createInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(64, "Max 64 characters"),
  scope: z.enum(API_SCOPES, "Pick an API"),
  expires_at: z.iso
    .datetime({ offset: true, message: "Pick an expiry date" })
    .refine((v) => {
      const t = new Date(v).getTime();
      const now = Date.now();
      return t > now + 3600_000 && t <= now + MAX_KEY_LIFETIME_DAYS * 86_400_000 + 60_000;
    }, `Expiry must be between 1 hour and ${MAX_KEY_LIFETIME_DAYS} days from now`),
});

export async function createApiKey(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  if (!(await isAuthenticated())) return { error: "Not allowed." };

  const parsed = createInput.safeParse({
    name: formData.get("name"),
    scope: formData.get("scope"),
    expires_at: formData.get("expires_at"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { key, prefix, hash } = generateKey();
  const { error } = await supabase
    .from("api_keys")
    .insert({
      name: parsed.data.name,
      scope: parsed.data.scope,
      expires_at: parsed.data.expires_at,
      key_prefix: prefix,
      key_hash: hash,
    });
  if (error) {
    console.error("[api-keys] create", error);
    return { error: "Could not create key." };
  }

  refresh();
  // Plaintext key leaves the server exactly once, here.
  return { created: { key, ...parsed.data } };
}

export async function revokeApiKey(id: string) {
  if (!(await isAuthenticated())) throw new Error("Not allowed.");
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", z.uuid().parse(id))
    .is("revoked_at", null);
  if (error) throw error;
  refresh();
}
