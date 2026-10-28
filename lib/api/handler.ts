import "server-only";
import { z } from "zod";
import { authenticate, type ApiKeyRow } from "@/lib/api/keys";
import type { ApiScope } from "@/lib/api/scopes";
import { supabase } from "@/lib/supabase/admin";

const MAX_BODY_BYTES = 256 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(status: number, code: string, message: string, issues?: unknown, headers?: HeadersInit) {
  return Response.json({ error: { code, message, ...(issues ? { issues } : {}) } }, { status, headers });
}

// Supabase errors are plain objects that log as `{}`; pull out the useful fields.
function logError(tag: string, err: unknown) {
  if (err instanceof Error) return console.error(tag, err);
  const { code, message, details, hint } = (err ?? {}) as Record<string, unknown>;
  console.error(tag, { code, message, details, hint });
}

// server_time lets senders without NTP detect clock drift.
const serverTime = () => Math.floor(Date.now() / 1000);

/**
 * Wraps an ingest route: API key auth (scoped), body size + JSON parsing, schema validation.
 * `handle` receives validated data and the authenticated key, and returns the JSON body for a 201
 * (`server_time` is appended).
 */
export function ingestRoute<S extends z.ZodType>(
  scope: ApiScope,
  schema: S,
  handle: (data: z.infer<S>, key: ApiKeyRow) => Promise<Record<string, unknown>>,
) {
  return async function POST(request: Request) {
    try {
      const auth = await authenticate(request, scope);
      if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);

      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return errorResponse(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return errorResponse(400, "invalid_json", "Body is not valid JSON.");
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        return errorResponse(422, "invalid_payload", "Payload failed validation.", issues);
      }

      const body = await handle(parsed.data, auth.key);
      return Response.json({ ...body, server_time: serverTime() }, { status: 201 });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
      logError(`[api:${scope}]`, err);
      return errorResponse(500, "internal_error", "Something went wrong.");
    }
  };
}

export type RateLimit = { limit: number; windowS: number; retryAfterS: number };

/**
 * Wraps a read route: API key auth (scoped), then a per-key rate limit. `handle` returns the JSON body
 * for a 200 (`server_time` is appended). Responses are never cached.
 */
export function readRoute(scope: ApiScope, rateLimit: RateLimit, handle: (key: ApiKeyRow) => Promise<Record<string, unknown>>) {
  return async function GET(request: Request) {
    try {
      const auth = await authenticate(request, scope);
      if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);

      const { data: hits, error } = await supabase.rpc("hit_rate_limit", {
        p_api_key_id: auth.key.id,
        p_window_s: rateLimit.windowS,
      });
      if (error) throw error;
      if ((hits as number) > rateLimit.limit) {
        const message = `Max ${rateLimit.limit} requests per ${rateLimit.windowS}s. Retry in ${rateLimit.retryAfterS}s.`;
        return errorResponse(429, "rate_limited", message, undefined, { "retry-after": String(rateLimit.retryAfterS) });
      }

      const body = await handle(auth.key);
      return Response.json({ ...body, server_time: serverTime() }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
      logError(`[api:${scope}:read]`, err);
      return errorResponse(500, "internal_error", "Something went wrong.");
    }
  };
}
