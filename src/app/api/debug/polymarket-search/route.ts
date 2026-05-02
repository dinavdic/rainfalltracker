import { NextRequest, NextResponse } from "next/server";
import { searchPolymarketEvents } from "@/lib/polymarket-fetcher";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "precipitation nyc";
  const { results, error } = await searchPolymarketEvents(q);
  return NextResponse.json({ query: q, results, error: error ?? null });
}
