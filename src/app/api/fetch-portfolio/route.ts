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
  // Signed contract count (string fixed-point). Positive = YES, negative = NO.
  position_fp?: string;
  // Cost basis strings in dollars (e.g. "34.35" for $34.35).
  total_traded_dollars?: string;
  market_exposure_dollars?: string;
  realized_pnl_dollars?: string;
  fees_paid_dollars?: string;
  [key: string]: unknown;
}

interface KalshiPositionsResponse {
  market_positions?: KalshiRawPosition[];
  event_positions?: unknown[];
  cursor?: string;
}

/**
 * Parse a Kalshi dollar string (e.g. "34.35") into an integer number of
 * cents. Returns 0 on missing/invalid input so arithmetic stays safe.
 */
function dollarsToCents(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function parseNum(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

async function fetchPortfolioPositions(): Promise<
  Record<string, KalshiPosition>
> {
  console.log("[portfolio] Fetching positions...");
  // Paginate in case there are more than 100 positions.
  const byTicker: Record<string, KalshiPosition> = {};
  let cursor: string | undefined;
  const MAX_PAGES = 20;
  let pages = 0;

  do {
    pages++;
    const qs = new URLSearchParams({ status: "open", limit: "100" });
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

    console.log(
      `[portfolio] GET ${KALSHI_API_BASE}${path} (page ${pages})`,
    );
    const resp = await fetch(`${KALSHI_API_BASE}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Kalshi /portfolio/positions ${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`,
      );
    }
    const data = (await resp.json()) as KalshiPositionsResponse;
    console.log(
      `[portfolio] Page ${pages}: ${data.market_positions?.length ?? 0} raw market_positions returned`,
    );

    for (const raw of data.market_positions || []) {
      if (!raw.ticker) continue;
      const positionSigned = parseNum(raw.position_fp);
      const quantity = Math.abs(positionSigned);
      const side: "yes" | "no" | null =
        positionSigned > 0 ? "yes" : positionSigned < 0 ? "no" : null;

      if (quantity === 0 || side === null) continue;

      // Only surface rainfall markets on the dashboard.
      if (!raw.ticker.startsWith("KXRAIN")) continue;

      // Dollar strings → cents.
      const totalTradedCents = dollarsToCents(raw.total_traded_dollars);
      const marketExposure = dollarsToCents(raw.market_exposure_dollars);
      const realizedPnl = dollarsToCents(raw.realized_pnl_dollars);
      const feesPaid = dollarsToCents(raw.fees_paid_dollars);

      // Average cost per contract, in cents. Derived from total_traded
      // (which is the lifetime cost basis for the currently-held
      // contracts when nothing's been closed out).
      const avgPrice = quantity > 0 ? totalTradedCents / quantity : null;

      const avgLabel = avgPrice !== null ? `${avgPrice.toFixed(1)}\u00A2` : "—";
      console.log(
        `[portfolio] ${raw.ticker}: ${side.toUpperCase()} \u00D7${quantity} @ ${avgLabel}`,
      );

      byTicker[raw.ticker] = {
        ticker: raw.ticker,
        position: positionSigned,
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
    console.error(`[portfolio] Error: ${msg}`);
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
