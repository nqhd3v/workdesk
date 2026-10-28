import { connection } from "next/server";
import { getBoardData } from "@/lib/board";

// Polled by the login board illustration. Request-time so builds don't need the database.
export async function GET() {
  await connection();
  try {
    return Response.json(await getBoardData(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[verify:live]", err);
    return Response.json({ temp_c: null, hum_pct: null, usage_pct: null }, { status: 503 });
  }
}
