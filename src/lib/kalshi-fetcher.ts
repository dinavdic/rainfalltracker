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
import {
  HAS_AUTH,
  KALSHI_API_BASE,
  signKalshiRequest,
} from "@/lib/kalshi-auth";

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  status: string;
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

function dollarsToCents(dollars: string | undefined | null): number | null {
  if (!dollars) return null;
  const val = parseFloat(dollars);
  if (isNaN(val) || val <= 0) return null;
  return Math.round(val * 100);
}

function parseVolume(fp: string | undefined | null): number {
  if (!fp) return 0;
  const val = parseFloat(fp);
  return isNaN(val) ? 0 : Math.round(val);
}

// Rate limiter: enforce minimum gap between Kalshi API requests
let lastKalshiRequest = 0;
const KALSHI_MIN_DELAY_MS = 250;
const KALSHI_OB_DELAY_MS = 100;

// Per-ticker record of the most recent orderbook bid/ask we saw.
const lastOrderbookValues = new Map<
  string,
  {
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
  }
>();

async function kalshiFetch(
  path: string,
  log: string[],
  delayMs: number = KALSHI_MIN_DELAY_MS,
  extraHeaders?: Record<string, string>,
): Promise<unknown | null> {
  const now = Date.now();
  const elapsed = now - lastKalshiRequest;
  if (elapsed < delayMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, delayMs - elapsed)
    );
  }
  lastKalshiRequest = Date.now();

  const url = `${KALSHI_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(extraHeaders || {}),
  };
  const auth = signKalshiRequest("GET", path);
  if (auth) {
    log.push(`[kalshi] Sign input: '${auth.signInput}'`);
    log.push(
      `[kalshi] Signature generated: ${auth.signature.substring(0, 20)}...`
    );
    headers["KALSHI-ACCESS-KEY"] = auth.keyId;
    headers["KALSHI-ACCESS-TIMESTAMP"] = auth.timestamp;
    headers["KALSHI-ACCESS-SIGNATURE"] = auth.signature;
    log.push(
      `[kalshi] Headers: KEY=${headers["KALSHI-ACCESS-KEY"]} TS=${headers["KALSHI-ACCESS-TIMESTAMP"]}`
    );
  }

  try {
    const resp = await fetch(url, {
      headers,
      cache: "no-store",
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

async function fetchOrderbook(
  ticker: string,
  log: string[],
  debugFirst: boolean = false,
): Promise<{
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
}> {
  const data = (await kalshiFetch(
    `/markets/${ticker}/orderbook?depth=10`,
    log,
    KALSHI_OB_DELAY_MS,
    { "Cache-Control": "no-cache" },
  )) as Record<string, unknown> | null;

  if (!data) {
    return { yesBid: null, yesAsk: null, noBid: null, noAsk: null };
  }

  if (debugFirst) {
    log.push(
      `[kalshi] Orderbook raw keys (${ticker}): ${JSON.stringify(Object.keys(data))}`
    );
    const fullJson = JSON.stringify(data);
    log.push(
      `[kalshi] Orderbook raw (${ticker}): ${fullJson.slice(0, 2000)}`
    );
  }

  let yesBid: number | null = null;
  let noBid: number | null = null;

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
      noBid = Math.max(...noSide.map((e) => e[0]));
    }
  }

  const obFp = data.orderbook_fp as
    | { yes_dollars?: string[][]; no_dollars?: string[][]; yes?: string[][]; no?: string[][] }
    | undefined;
  if (obFp && yesBid === null && noBid === null) {
    const yesDollars = obFp.yes_dollars || obFp.yes || [];
    const noDollars = obFp.no_dollars || obFp.no || [];

    if (yesDollars.length > 0) {
      const prices = yesDollars
        .map((e) => Math.round(parseFloat(e[0]) * 100))
        .filter((p) => !isNaN(p));
      if (prices.length > 0) yesBid = Math.max(...prices);
    }
    if (noDollars.length > 0) {
      const prices = noDollars
        .map((e) => Math.round(parseFloat(e[0]) * 100))
        .filter((p) => !isNaN(p));
      if (prices.length > 0) noBid = Math.max(...prices);
    }
  }

  const yesAsk = noBid !== null ? 100 - noBid : null;
  const noAsk = yesBid !== null ? 100 - yesBid : null;

  if (debugFirst) {
    log.push(
      `[kalshi] Orderbook parsed (${ticker}): yesBid=${yesBid}c yesAsk=${yesAsk}c noBid=${noBid}c noAsk=${noAsk}c`
    );
  }

  return { yesBid, yesAsk, noBid, noAsk };
}

function extractThreshold(market: KalshiMarket): number | null {
  if (
    market.floor_strike !== undefined &&
    market.floor_strike !== null
  ) {
    const strike = market.floor_strike;
    if (strike >= 0.5 && strike <= 10) {
      return strike;
    }
    if (strike >= 50 && strike <= 1000) {
      return strike / 100;
    }
  }

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

  const ticker = market.ticker;
  const tickerPatterns = [
    /-B(\d+(?:\.\d+)?)$/,
    /-T(\d+)$/,
    /-(\d+(?:\.\d+)?)$/,
  ];

  for (const pat of tickerPatterns) {
    const match = ticker.match(pat);
    if (match) {
      let val = parseFloat(match[1]);
      if (val > 10) val = val / 100;
      if (!isNaN(val) && val >= 0.5 && val <= 10) {
        return val;
      }
    }
  }

  return null;
}

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

export async function discoverAndFetchMarkets(
  log: string[]
): Promise<Record<string, KalshiStationData>> {
  const result: Record<string, KalshiStationData> = {};

  for (const station of STATIONS) {
    result[station.code] = { thresholds: {}, eventTicker: null };
  }

  const seenTickers = new Set<string>();
  let sfoLogged = false;

  function processMarkets(
    markets: KalshiMarket[],
    defaultStation: string | null
  ) {
    for (const market of markets) {
      if (seenTickers.has(market.ticker)) continue;
      seenTickers.add(market.ticker);

      const station =
        defaultStation || matchStationByTitle(market.title);
      if (!station || !result[station]) continue;

      const threshold = extractThreshold(market);
      if (threshold === null) {
        log.push(
          `[kalshi] Could not extract threshold from: ${market.ticker} "${market.title}"`
        );
        continue;
      }

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

      const yesBid = dollarsToCents(market.yes_bid_dollars);
      const yesAsk = dollarsToCents(market.yes_ask_dollars);
      const lastPrice = dollarsToCents(market.last_price_dollars);
      const volume = parseVolume(market.volume_fp);
      const isStale = yesBid === null || yesAsk === null;

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

      const noBid = yesAsk !== null ? 100 - yesAsk : null;
      const noAsk = yesBid !== null ? 100 - yesBid : null;

      const price: KalshiMarketPrice = {
        ticker: market.ticker,
        lastPrice,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
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

  log.push("[kalshi] === Strategy 1: Series ticker search ===");

  const stationOrder = STATIONS
    .map((s) => s.code)
    .sort((a, b) => {
      if (a === "HOU") return -1;
      if (b === "HOU") return 1;
      return 0;
    });

  for (const stationCode of stationOrder) {
    const candidates = KALSHI_SERIES_CANDIDATES[stationCode] || [];
    if (candidates.length === 0) continue;

    for (const seriesTicker of candidates) {
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
        break;
      }
    }
  }

  log.push("[kalshi] === Strategy 2: Broad event search ===");

  const eventsData = (await kalshiFetch(
    `/events?status=open&limit=100&with_nested_markets=true&series_ticker=`,
    log
  )) as { events?: Array<{ event_ticker: string; title: string; markets?: KalshiMarket[] }> } | null;

  const broadSearch = (await kalshiFetch(
    `/markets?status=open&limit=200`,
    log
  )) as KalshiMarketsResponse | null;

  if (broadSearch?.markets?.length) {
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

  log.push("[kalshi] === Orderbook refresh for live bid/ask ===");
  let orderbookFetches = 0;
  let debuggedFirst = false;

  for (const station of STATIONS) {
    for (const [thresholdKey, price] of Object.entries(
      result[station.code].thresholds
    )) {
      const isDebug = !debuggedFirst;
      const ob = await fetchOrderbook(price.ticker, log, isDebug);
      if (isDebug) debuggedFirst = true;
      orderbookFetches++;

      if (
        ob.yesBid !== null ||
        ob.yesAsk !== null ||
        ob.noBid !== null ||
        ob.noAsk !== null
      ) {
        const oldBid = price.yesBid;
        const oldAsk = price.yesAsk;

        const prevOb = lastOrderbookValues.get(price.ticker);
        const unchanged =
          prevOb !== undefined &&
          prevOb.yesBid === ob.yesBid &&
          prevOb.yesAsk === ob.yesAsk &&
          prevOb.noBid === ob.noBid &&
          prevOb.noAsk === ob.noAsk;

        if (unchanged && price.lastPrice !== null) {
          log.push(
            `[kalshi] ${station.code} >${thresholdKey}" orderbook unchanged, using lastPrice=${price.lastPrice}c`
          );
          price.yesBid = price.lastPrice;
          price.yesAsk = price.lastPrice;
          price.noBid = 100 - price.lastPrice;
          price.noAsk = 100 - price.lastPrice;
          price.isStale = false;
        } else {
          if (ob.yesBid !== null) price.yesBid = ob.yesBid;
          if (ob.yesAsk !== null) price.yesAsk = ob.yesAsk;
          if (ob.noBid !== null) price.noBid = ob.noBid;
          if (ob.noAsk !== null) price.noAsk = ob.noAsk;
          price.isStale = price.yesBid === null || price.yesAsk === null;

          log.push(
            `[kalshi] OB ${station.code} >${thresholdKey}": ` +
              `bid ${oldBid}c->${price.yesBid}c  ask ${oldAsk}c->${price.yesAsk}c ` +
              `noBid=${price.noBid}c noAsk=${price.noAsk}c`
          );
        }

        lastOrderbookValues.set(price.ticker, {
          yesBid: ob.yesBid,
          yesAsk: ob.yesAsk,
          noBid: ob.noBid,
          noAsk: ob.noAsk,
        });
      } else {
        log.push(
          `[kalshi] OB ${station.code} >${thresholdKey}": empty orderbook`
        );
      }
    }
  }

  log.push(`[kalshi] Orderbook: ${orderbookFetches} fetched`);

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

/**
 * Direct in-process Kalshi fetch — bypasses HTTP so callers like the
 * probe don't hit Vercel Deployment Protection or internal routing
 * issues. Same logic as the GET handler in /api/fetch-kalshi.
 */
export async function fetchKalshiDirect(): Promise<KalshiApiResponse> {
  const log: string[] = [];
  log.push(
    `[kalshi] Direct fetch (${HAS_AUTH ? "authenticated" : "unauth"}) at ${new Date().toISOString()}`,
  );

  const stations = await discoverAndFetchMarkets(log);

  for (const line of log) console.log(line);

  return {
    stations,
    fetchedAt: new Date().toISOString(),
    discoveryLog: log,
  };
}
