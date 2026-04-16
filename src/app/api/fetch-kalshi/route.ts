import { NextResponse } from "next/server";
import { KalshiApiResponse } from "@/lib/types";
import {
  HAS_AUTH,
  KALSHI_API_KEY_ID,
  KALSHI_PRIVATE_KEY,
} from "@/lib/kalshi-auth";
import { discoverAndFetchMarkets } from "@/lib/kalshi-fetcher";

export const dynamic = "force-dynamic";

export async function GET() {
  console.log("[kalshi] FRESH FETCH (no cache)");

  const log: string[] = [];
  log.push("[kalshi] FRESH FETCH (no cache)");
  log.push(
    `[kalshi] Auth mode: ${HAS_AUTH ? "authenticated (signed headers)" : "unauthenticated (no headers)"}`
  );
  if (HAS_AUTH) {
    log.push(
      `[kalshi] Auth enabled: keyId=${(KALSHI_API_KEY_ID as string).substring(0, 8)}... keyLength=${(KALSHI_PRIVATE_KEY as string).length}`
    );
  }
  log.push(
    `[kalshi] Starting Kalshi market discovery at ${new Date().toISOString()}`
  );

  const stations = await discoverAndFetchMarkets(log);

  // Print all logs to console for Vercel log debugging
  for (const line of log) {
    console.log(line);
  }

  const response: KalshiApiResponse = {
    stations,
    fetchedAt: new Date().toISOString(),
    discoveryLog: log,
  };

  return NextResponse.json(response, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
