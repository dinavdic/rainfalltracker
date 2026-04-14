import { NextResponse } from "next/server";
import { KalshiPortfolioResponse, KalshiPosition } from "@/lib/types";
import {
  HAS_AUTH,
  KALSHI_API_BASE,
  signKalshiRequest,
} from "@/lib/kalshi-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/fetch-portfolio
 *
 * Read-only Kalshi portfolio display. Fetches the caller's current
 * positions via the authenticated /portfolio/positions endpoint and
 * returns them keyed by market ticker so the dashboard can attach
 * position info to the matching threshold row.
 *
 * No order placement — this route never POSTs to Kalshi.
 *
 * Returns `{ authenticated: false, positions: {} }` when the server
 * isn't configured with Kalshi credentials.
 */

interface KalshiRawPosition {
  ticker: string;
  // Signed contract count: positive = YES, negative = NO.
  position?: number;
  // Cost basis for currently held contracts, in cents (integer).
  market_exposure?: number;
  // Realized P&L in cents.
  realized_pnl?: number;
  // Fees paid in cents.
  fees_paid?: number;
  // Cumulative traded amount (not used for avg price).
  total_traded?: number;
  [key: string]: unknown;
}

interface KalshiPositionsResponse {
  market_positions?: KalshiRawPosition[];
  event_positions?: unknown[];
  cursor?: string;
}

function safeInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  return 0;
}

async function fetchPortfolioPositions(): Promise<
  Record<string, KalshiPosition>
> {
  // Paginate in case there are more than 100 positions.
  const byTicker: Record<string, KalshiPosition> = {};
  let cursor: string | undefined;
  const MAX_PAGES = 20;
  let pages = 0;

  do {
    pages++;
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const path = `/portfolio/positions?${qs.toString()}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = signKalshiRequest("GET", path);
    if (!auth) {
      throw new Error("Kalshi auth required for /portfolio/positions");
    }
    headers["KALSHI-ACCESS-KEY"] = auth.keyId;
    headers["KALSHI-ACCESS-TIMESTAMP"] = auth.timestamp;
    headers["KALSHI-ACCESS-SIGNATURE"] = auth.signature;

    const resp = await fetch(`${KALSHI_API_BASE}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      throw new Error(
        `Kalshi /portfolio/positions ${resp.status} ${resp.statusText}`,
      );
    }
    const data = (await resp.json()) as KalshiPositionsResponse;

    for (const raw of data.market_positions || []) {
      if (!raw.ticker) continue;
      const position = safeInt(raw.position);
      if (position === 0) continue; // skip closed-out tickers
      const marketExposure = Math.abs(safeInt(raw.market_exposure));
      const realizedPnl = safeInt(raw.realized_pnl);
      const feesPaid = safeInt(raw.fees_paid);
      const absPos = Math.abs(position);
      const avgPrice = absPos > 0 ? marketExposure / absPos : null;

      byTicker[raw.ticker] = {
        ticker: raw.ticker,
        position,
        marketExposure,
        realizedPnl,
        feesPaid,
        avgPrice,
      };
    }

    cursor = data.cursor || undefined;
  } while (cursor && pages < MAX_PAGES);

  return byTicker;
}

export async function GET() {
  const fetchedAt = new Date().toISOString();

  if (!HAS_AUTH) {
    const response: KalshiPortfolioResponse = {
      authenticated: false,
      positions: {},
      fetchedAt,
    };
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  try {
    const positions = await fetchPortfolioPositions();
    console.log(
      `[portfolio] Fetched ${Object.keys(positions).length} open positions`,
    );
    const response: KalshiPortfolioResponse = {
      authenticated: true,
      positions,
      fetchedAt,
    };
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[portfolio] ${msg}`);
    const response: KalshiPortfolioResponse = {
      authenticated: true,
      positions: {},
      fetchedAt,
      error: msg,
    };
    return NextResponse.json(response, {
      status: 500,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
}
