import { authenticate } from "@/lib/api/keys";

// OTLP/HTTP receiver for Claude Code telemetry (https://code.claude.com/docs/en/monitoring-usage).
// Exporters append the signal path to OTEL_EXPORTER_OTLP_ENDPOINT, so this catches
// /api/usage-state/otlp, /otlp/v1/metrics, /otlp/v1/logs and /otlp/v1/traces.
//
// Exploratory: payloads are only logged for now, nothing is stored. Use OTEL_EXPORTER_OTLP_PROTOCOL=http/json
// so the logs are readable; protobuf bodies are logged as size + base64 prefix.

// Vercel's request body cap is 4.5 MB; log batches can be large.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function otlpError(status: number, message: string) {
  // OTLP/HTTP error body is a google.rpc.Status; JSON form works for both encodings' clients to log.
  return Response.json({ code: status, message }, { status });
}

async function readBody(request: Request): Promise<Uint8Array> {
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  let stream = request.body;
  if (!stream) return new Uint8Array();
  if (encoding === "gzip" || encoding === "deflate") stream = stream.pipeThrough(new DecompressionStream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function POST(request: Request, ctx: RouteContext<"/api/usage-state/otlp/[[...signal]]">) {
  const path = (await ctx.params).signal?.join("/") ?? "";
  try {
    const auth = await authenticate(request, "usage_state");
    if (!auth.ok) return otlpError(auth.status, auth.message);

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return otlpError(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);

    const bytes = await readBody(request);
    const contentType = request.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const meta = {
      path: `/${path}`,
      key: auth.key.name,
      content_type: contentType,
      content_encoding: request.headers.get("content-encoding"),
      bytes: bytes.byteLength,
    };

    if (isJson) {
      const text = new TextDecoder().decode(bytes);
      try {
        console.log("[api:usage_state:otlp]", JSON.stringify({ ...meta, body: JSON.parse(text) }));
      } catch {
        console.log("[api:usage_state:otlp] invalid json", JSON.stringify({ ...meta, body: text.slice(0, 4000) }));
        return otlpError(400, "Body is not valid JSON.");
      }
      // Empty Export*ServiceResponse = full success.
      return Response.json({}, { status: 200 });
    }

    const b64 = Buffer.from(bytes.subarray(0, 2048)).toString("base64");
    console.log("[api:usage_state:otlp] protobuf", JSON.stringify({ ...meta, base64_prefix: b64 }));
    return new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/x-protobuf" } });
  } catch (err) {
    console.error("[api:usage_state:otlp]", path, err);
    // 503 is retryable for OTLP exporters.
    return otlpError(503, "Something went wrong.");
  }
}
