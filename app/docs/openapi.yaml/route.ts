import { readDoc } from "@/lib/docs";

// Public: serves the OpenAPI contract next to the docs page.
export async function GET() {
  return new Response(await readDoc("openapi.yaml"), {
    headers: { "content-type": "application/yaml; charset=utf-8" },
  });
}
