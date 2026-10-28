import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ApiScope } from "@/lib/api/scopes";
import { supabase } from "@/lib/supabase/admin";

export const KEY_HEADER = "x-workdesk-key";
const KEY_PATTERN = /^wdk_[A-Za-z0-9_-]{43}$/;

export type ApiKeyRow = {
  id: string;
  name: string;
  scope: ApiScope;
  key_prefix: string;
  device_id: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const KEY_COLUMNS = "id, name, scope, key_prefix, device_id, created_at, expires_at, last_used_at, revoked_at";

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

/** Returns the plaintext key (show once) and what to persist. */
export function generateKey() {
  const key = `wdk_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export type AuthResult =
  | { ok: true; key: ApiKeyRow }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticate(request: Request, scope: ApiScope): Promise<AuthResult> {
  const raw = request.headers.get(KEY_HEADER)?.trim();
  if (!raw || !KEY_PATTERN.test(raw)) {
    return { ok: false, status: 401, code: "unauthorized", message: `Missing or malformed ${KEY_HEADER} header.` };
  }

  const { data, error } = await supabase
    .from("api_keys")
    .select(KEY_COLUMNS)
    .eq("key_hash", hashKey(raw))
    .is("revoked_at", null)
    .maybeSingle<ApiKeyRow>();
  if (error) throw error;

  if (!data) return { ok: false, status: 401, code: "unauthorized", message: "Invalid or revoked API key." };
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, code: "key_expired", message: "API key expired. Ask the owner for a new key." };
  }
  if (data.scope !== scope) {
    return { ok: false, status: 403, code: "forbidden", message: `This key is for the "${data.scope}" API.` };
  }

  await supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { ok: true, key: data };
}

/** All keys for the settings page: active first, newest first. */
export async function listApiKeys() {
  return supabase
    .from("api_keys")
    .select(KEY_COLUMNS)
    .order("revoked_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .returns<ApiKeyRow[]>();
}
