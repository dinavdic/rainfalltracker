import { NextRequest, NextResponse } from "next/server";
import {
  KalshiApiResponse,
  KalshiStationData,
  KalshiMarketPrice,
} from "@/lib/types";
import {
  STATIONS,
  THRESHOLDS,
  KALSHI_SERIES_CANDIDATES,
  KALSHI_CITY_KEYWORDS,
} from "@/lib/stations";

export const dynamic = "force-dynamic";

const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// In-memory cache (5-minute TTL)
let cachedResponse: KalshiApiResponse | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  status: string;
  // Kalshi v2 API returns dollar amounts as strings (e.g., "0.56")
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  floor_strike?: number;
  custom_strike?: number;
  [key: string]: unknown;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

/**
 * Parse a Kalshi dollar string (e.g., "0.56") to cents (56).
 * Returns null if the value is missing, empty, or zero.
 */
function dollarsToCents(dollars: string | undefined | null): number | null {
  if (!dollars) return null;
  const val = parseFloat(dollars);
  if (isNaN(val) || val <= 0) return null;
  return Math.round(val * 100);
}

/**
 * Parse a Kalshi fixed-point volume string (e.g., "150.00") to an integer.
 */
function parseVolume(fp: string | undefined | null): number {
  if (!fp) return 0;
  const val = parseFloat(fp);
  return isNaN(val) ? 0 : Math.round(val);
}

// Rate limiter: enforce minimum gap between Kalshi API requests
let lastKalshiRequest = 0;
const KALSHI_MIN_DELAY_MS = 250; // 250ms for market discovery requests
const KALSHI_OB_DELAY_MS = 100; // 100ms for lightweight orderbook requests

// Orderbook cache (in-memory, 60s TTL per ticker)
const orderbookCache = new Map<
  string,
  { yesBid: number | null; yesAsk: number | null; ts: number }
>();
const ORDERBOOK_CACHE_TTL_MS = 60 * 1000;

/**
 * Fetch from Kalshi API with rate limiting and error handling.
 * @param delayMs - minimum gap since last request (default 250ms, use 100ms for orderbook)
 */
async function kalshiFetch(
  path: string,
  log: string[],
  delayMs: number = KALSHI_MIN_DELAY_MS,
): Promise<unknown | null> {
  // Enforce rate limit
  const now = Date.now();
  const elapsed = now - lastKalshiRequest;
  if (elapsed < delayMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, delayMs - elapsed)
    );
  }
  lastKalshiRequest = Date.now();

  const url = `${KALSHI_API_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      log.push(`[kalshi] ${url} -> ${resp.status} ${resp.statusText}`);
      return null;
    }

    return await resp.json();
  } catch (e) {
    log.push(
      `[kalshi] ${url} -> error: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * Fetch live top-of-book bid/ask from the orderbook endpoint for a ticker.
 *
 * Kalshi v2 API may return the orderbook in multiple formats:
 *   - { orderbook: { yes: [[cents, qty], ...], no: [...] } }
 *   - { orderbook_fp: { yes_dollars: [["0.40", "100"], ...], no_dollars: [...] } }
 *
 * We try all known formats and extract top-of-book prices.
 *
 * Returns cached result if within 60s TTL.
 */
async function fetchOrderbook(
  ticker: string,
  log: string[],
  debugFirst: boolean = false,
): Promise<{ yesBid: number | null; yesAsk: number | null }> {
  const cached = orderbookCache.get(ticker);
  if (cached && Date.now() - cached.ts < ORDERBOOK_CACHE_TTL_MS) {
    return { yesBid: cached.yesBid, yesAsk: cached.yesAsk };
  }

  // Use Record<string, unknown> so we can inspect all top-level keys
  const data = (await kalshiFetch(
    `/markets/${ticker}/orderbook`,
    log,
    KALSHI_OB_DELAY_MS,
  )) as Record<string, unknown> | null;

  if (!data) {
    return { yesBid: null, yesAsk: null };
  }

  // Always log the full raw response structure for the first orderbook
  if (debugFirst) {
    log.push(
      `[kalshi] Orderbook raw keys (${ticker}): ${JSON.stringify(Object.keys(data))}`
    );
    // Log up to 2000 chars of the full response
    const fullJson = JSON.stringify(data);
    log.push(
      `[kalshi] Orderbook raw (${ticker}): ${fullJson.slice(0, 2000)}`
    );
  }

  let yesBid: number | null = null;
  let yesAsk: number | null = null;

  // --- Format 1: orderbook.yes / orderbook.no (integer cents) ---
  const ob = data.orderbook as
    | { yes?: number[][]; no?: number[][] }
    | undefined;
  if (ob) {
    const yesSide = ob.yes || [];
    const noSide = ob.no || [];

    if (yesSide.length > 0) {
      yesBid = Math.max(...yesSide.map((e) => e[0]));
    }
    if (noSide.length > 0) {
      yesAsk = 100 - Math.max(...noSide.map((e) => e[0]));
    }
  }

  // --- Format 2: orderbook_fp with dollar strings ---
  // e.g. { yes_dollars: [["0.40", "100"], ...], no_dollars: [["0.55", "80"], ...] }
  const obFp = data.orderbook_fp as
    | { yes_dollars?: string[][]; no_dollars?: string[][]; yes?: string[][]; no?: string[][] }
    | undefined;
  if (obFp && yesBid === null && yesAsk === null) {
    const yesDollars = obFp.yes_dollars || obFp.yes || [];
    const noDollars = obFp.no_dollars || obFp.no || [];

    if (yesDollars.length > 0) {
      const prices = yesDollars.map((e) => Math.round(parseFloat(e[0]) * 100));
      yesBid = Math.max(...prices.filter((p) => !isNaN(p)));
    }
    if (noDollars.length > 0) {
      const prices = noDollars.map((e) => Math.round(parseFloat(e[0]) * 100));
      const bestNoBid = Math.max(...prices.filter((p) => !isNaN(p)));
      if (!isNaN(bestNoBid)) {
        yesAsk = 100 - bestNoBid;
      }
    }
  }

  if (debugFirst) {
    log.push(
      `[kalshi] Orderbook parsed (${ticker}): yesBid=${yesBid}c yesAsk=${yesAsk}c`
    );
  }

  const result = { yesBid, yesAsk };
  orderbookCache.set(ticker, { ...result, ts: Date.now() });
  return result;
}

/**
 * Try to extract a rainfall threshold (in inches) from a market's ticker or title.
 * Returns null if we can't determine the threshold.
 */
function extractThreshold(market: KalshiMarket): number | null {
  // Check floor_strike / custom_strike first (may be in cents/inches)
  if (
    market.floor_strike !== undefined &&
    market.floor_strike !== null
  ) {
    // floor_strike may be the threshold in various formats
    const strike = market.floor_strike;
    // If it looks like an inch value (1-10 range), use it directly
    if (strike >= 0.5 && strike <= 10) {
      return strike;
    }
    // If it looks like hundredths (100 = 1 inch), convert
    if (strike >= 50 && strike <= 1000) {
      return strike / 100;
    }
  }

  // Parse from title: "more than 2 inches", "above 3.0 inches", ">2"", etc.
  const title = market.title.toLowerCase();
  const titlePatterns = [
    /(?:more than|above|over|exceed|>)\s*(\d+(?:\.\d+)?)\s*(?:inch|"|'')/,
    /(\d+(?:\.\d+)?)\s*(?:inch|"|'')\s*(?:or more|of rain)/,
    /(?:at least|>=)\s*(\d+(?:\.\d+)?)\s*(?:inch|"|'')/,
  ];

  for (const pat of titlePatterns) {
    const match = title.match(pat);
    if (match) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val >= 0.5 && val <= 10) {
        return val;
      }
    }
  }

  // Parse from ticker: e.g., "...-B2.0", "...-T200", "...-2"
  const ticker = market.ticker;
  const tickerPatterns = [
    /-B(\d+(?:\.\d+)?)$/,    // -B2.0
    /-T(\d+)$/,               // -T200 (hundredths)
    /-(\d+(?:\.\d+)?)$/,      // -2.0
  ];

  for (const pat of tickerPatterns) {
    const match = ticker.match(pat);
    if (match) {
      let val = parseFloat(match[1]);
      // If > 10, likely hundredths
      if (val > 10) val = val / 100;
      if (!isNaN(val) && val >= 0.5 && val <= 10) {
        return val;
      }
    }
  }

  return null;
}

/**
 * Try to match a market to one of our stations by title keywords.
 */
function matchStationByTitle(title: string): string | null {
  const lower = title.toLowerCase();
  for (const [stationCode, keywords] of Object.entries(KALSHI_CITY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return stationCode;
      }
    }
  }
  return null;
}

/**
 * Discover and fetch Kalshi rainfall markets for all stations.
 *
 * Strategy:
 * 1. Try known series ticker patterns per station
 * 2. Broad search for "rain" markets as fallback
 * 3. Match markets to stations via title keywords
 * 4. Log everything for debugging
 */
async function discoverAndFetchMarkets(
  log: string[]
): Promise<Record<string, KalshiStationData>> {
  const result: Record<string, KalshiStationData> = {};

  // Initialize empty data for each station
  for (const station of STATIONS) {
    result[station.code] = { thresholds: {}, eventTicker: null };
  }

  // Track which tickers we've seen to avoid duplicates
  const seenTickers = new Set<string>();

  // Track whether we've logged the SFO price debug line
  let sfoLogged = false;

  /**
   * Process a set of markets: extract threshold, match station, store price.
   */
  function processMarkets(
    markets: KalshiMarket[],
    defaultStation: string | null
  ) {
    for (const market of markets) {
      if (seenTickers.has(market.ticker)) continue;
      seenTickers.add(market.ticker);

      // Determine which station this market belongs to
      const station =
        defaultStation || matchStationByTitle(market.title);
      if (!station || !result[station]) continue;

      // Extract threshold
      const threshold = extractThreshold(market);
      if (threshold === null) {
        log.push(
          `[kalshi] Could not extract threshold from: ${market.ticker} "${market.title}"`
        );
        continue;
      }

      // Find closest matching threshold from our list
      const matchedThreshold = THRESHOLDS.find(
        (t) => Math.abs(t - threshold) < 0.1
      );
      if (!matchedThreshold) {
        log.push(
          `[kalshi] Threshold ${threshold}" from ${market.ticker} doesn't match any of ours`
        );
        continue;
      }

      const thresholdKey = matchedThreshold.toFixed(1);

      // Parse prices: Kalshi v2 returns dollar strings, convert to cents
      const yesBid = dollarsToCents(market.yes_bid_dollars);
      const yesAsk = dollarsToCents(market.yes_ask_dollars);
      const lastPrice = dollarsToCents(market.last_price_dollars);
      const volume = parseVolume(market.volume_fp);
      const isStale = yesBid === null || yesAsk === null;

      // Diagnostic logging: dump all price-related fields for first SFO market
      if (station === "SFO" && !sfoLogged) {
        sfoLogged = true;
        const priceFields: Record<string, unknown> = {};
        for (const k of Object.keys(market)) {
          if (
            k.includes("price") || k.includes("bid") || k.includes("ask") ||
            k.includes("dollar") || k.includes("volume") || k.includes("cost")
          ) {
            priceFields[k] = market[k];
          }
        }
        log.push(
          `[kalshi] SFO price debug (${market.ticker}): ` +
            `raw=${JSON.stringify(priceFields)} ` +
            `parsed: bid=${yesBid}c ask=${yesAsk}c last=${lastPrice}c isStale=${isStale}`
        );
      }

      const price: KalshiMarketPrice = {
        ticker: market.ticker,
        lastPrice,
        yesBid,
        yesAsk,
        volume,
        isStale,
      };

      result[station].thresholds[thresholdKey] = price;
      if (!result[station].eventTicker) {
        result[station].eventTicker = market.event_ticker || null;
      }

      log.push(
        `[kalshi] Mapped: ${market.ticker} -> ${station} >${thresholdKey}" ` +
          `(bid=${yesBid}c ask=${yesAsk}c last=${lastPrice}c vol=${volume})`
      );
    }
  }

  // --- Strategy 1: Try known series tickers per station ---
  // Process stations in a specific order to get HOU earlier (before rate limits bite)
  log.push("[kalshi] === Strategy 1: Series ticker search ===");

  const stationOrder = STATIONS
    .map((s) => s.code)
    .sort((a, b) => {
      // Prioritize HOU early to avoid rate limits after many requests
      if (a === "HOU") return -1;
      if (b === "HOU") return 1;
      return 0;
    });

  for (const stationCode of stationOrder) {
    const candidates = KALSHI_SERIES_CANDIDATES[stationCode] || [];
    if (candidates.length === 0) continue;

    for (const seriesTicker of candidates) {
      // Search for markets directly (skip the /series check to halve request count)
      const data = (await kalshiFetch(
        `/markets?status=open&limit=100&series_ticker=${seriesTicker}`,
        log
      )) as KalshiMarketsResponse | null;

      if (data?.markets?.length) {
        log.push(
          `[kalshi] Found ${data.markets.length} markets for series ${seriesTicker}`
        );
        for (const m of data.markets) {
          log.push(
            `[kalshi]   ${m.ticker}: "${m.title}" bid=$${m.yes_bid_dollars} ask=$${m.yes_ask_dollars} last=$${m.last_price_dollars} vol=${m.volume_fp}`
          );
        }
        processMarkets(data.markets, stationCode);
        break; // Found markets for this station, skip other candidates
      }
    }
  }

  // --- Strategy 2: Broad search for rainfall markets ---
  log.push("[kalshi] === Strategy 2: Broad event search ===");

  // Search for events containing "rain"
  const eventsData = (await kalshiFetch(
    `/events?status=open&limit=100&with_nested_markets=true&series_ticker=`,
    log
  )) as { events?: Array<{ event_ticker: string; title: string; markets?: KalshiMarket[] }> } | null;

  // Also try searching markets directly
  const broadSearch = (await kalshiFetch(
    `/markets?status=open&limit=200`,
    log
  )) as KalshiMarketsResponse | null;

  if (broadSearch?.markets?.length) {
    // Filter for rainfall-related markets
    const rainfallMarkets = broadSearch.markets.filter((m) => {
      const lower = (m.title || "").toLowerCase();
      return (
        lower.includes("rain") ||
        lower.includes("precipitation") ||
        lower.includes("rainfall") ||
        lower.includes("inches of rain")
      );
    });

    if (rainfallMarkets.length > 0) {
      log.push(
        `[kalshi] Found ${rainfallMarkets.length} rainfall markets in broad search`
      );
      for (const m of rainfallMarkets) {
        log.push(
          `[kalshi]   ${m.ticker}: "${m.title}" event=${m.event_ticker}`
        );
      }
      processMarkets(rainfallMarkets, null);
    } else {
      log.push(
        `[kalshi] No rainfall markets found in ${broadSearch.markets.length} total open markets`
      );
      // Log a sample of tickers to help debug what's available
      const sample = broadSearch.markets.slice(0, 10);
      for (const m of sample) {
        log.push(`[kalshi]   sample: ${m.ticker}: "${m.title}"`);
      }
    }
  }

  if (eventsData?.events?.length) {
    const rainfallEvents = eventsData.events.filter((e) => {
      const lower = (e.title || "").toLowerCase();
      return lower.includes("rain") || lower.includes("precipitation");
    });

    if (rainfallEvents.length > 0) {
      log.push(
        `[kalshi] Found ${rainfallEvents.length} rainfall events`
      );
      for (const evt of rainfallEvents) {
        log.push(
          `[kalshi]   event: ${evt.event_ticker}: "${evt.title}" (${evt.markets?.length || 0} markets)`
        );
        if (evt.markets) {
          processMarkets(evt.markets, null);
        }
      }
    }
  }

  // --- Orderbook refresh: replace ALL summary prices with live top-of-book ---
  // The /markets endpoint returns stale bid/ask data (can be >1 hour old)
  // even when spreads look tight, so we fetch the orderbook for every market.
  log.push("[kalshi] === Orderbook refresh for live bid/ask ===");
  let orderbookFetches = 0;
  let debuggedFirst = false;

  for (const station of STATIONS) {
    for (const [thresholdKey, price] of Object.entries(
      result[station.code].thresholds
    )) {
      // Fetch live orderbook for every mapped market
      const isDebug = !debuggedFirst;
      const ob = await fetchOrderbook(price.ticker, log, isDebug);
      if (isDebug) debuggedFirst = true;
      orderbookFetches++;

      if (ob.yesBid !== null || ob.yesAsk !== null) {
        const oldBid = price.yesBid;
        const oldAsk = price.yesAsk;

        if (ob.yesBid !== null) price.yesBid = ob.yesBid;
        if (ob.yesAsk !== null) price.yesAsk = ob.yesAsk;
        price.isStale = price.yesBid === null || price.yesAsk === null;

        log.push(
          `[kalshi] OB ${station.code} >${thresholdKey}": ` +
            `bid ${oldBid}c->${price.yesBid}c  ask ${oldAsk}c->${price.yesAsk}c`
        );
      } else {
        log.push(
          `[kalshi] OB ${station.code} >${thresholdKey}": empty orderbook`
        );
      }
    }
  }

  log.push(`[kalshi] Orderbook: ${orderbookFetches} fetched`);

  // --- Summary ---
  let totalMapped = 0;
  for (const station of STATIONS) {
    const count = Object.keys(result[station.code].thresholds).length;
    if (count > 0) {
      log.push(
        `[kalshi] ${station.code}: ${count} thresholds mapped`
      );
      totalMapped += count;
    }
  }
  log.push(`[kalshi] Total: ${totalMapped} market-threshold mappings`);

  return result;
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("force") === "1";

  // Check cache
  if (!forceRefresh && cachedResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return NextResponse.json(cachedResponse);
  }

  const log: string[] = [];
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

  // Cache the result
  cachedResponse = response;
  cacheTimestamp = Date.now();

  return NextResponse.json(response);
}
