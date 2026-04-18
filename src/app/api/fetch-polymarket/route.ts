import { NextResponse } from "next/server";
import { fetchPolymarketNYC } from "@/lib/polymarket-fetcher";

export const dynamic = "force-dynamic";

export async function GET() {
  const log: string[] = [];
  log.push(`[polymarket] FRESH FETCH (no cache) at ${new Date().toISOString()}`);
  const response = await fetchPolymarketNYC(log);
  for (const line of log) console.log(line);
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
