import "server-only";
import { z } from "zod";
import { authenticate, type ApiKeyRow } from "@/lib/api/keys";
import type { ApiScope } from "@/lib/api/scopes";

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

function errorResponse(status: number, code: string, message: string, issues?: unknown) {
  return Response.json({ error: { code, message, ...(issues ? { issues } : {}) } }, { status });
}

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
      // server_time lets senders without NTP detect clock drift.
      return Response.json({ ...body, server_time: Math.floor(Date.now() / 1000) }, { status: 201 });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
      console.error(`[api:${scope}]`, err);
      return errorResponse(500, "internal_error", "Something went wrong.");
    }
  };
}
