import { PolymarketApiResponse, PolymarketOutcome } from "@/lib/types";

/**
 * Fetch the current-month NYC rainfall event from Polymarket, parse its
 * mutually exclusive bucket outcomes (e.g. <2, 2-3, 3-4, 4-5, 5-6, >6
 * inches in April), and pull each outcome's live YES bid/ask from the
 * CLOB orderbook. May and later months may use different bin
 * boundaries — the bucket parser is defensive and the actual labels
 * are logged on every fetch.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

/**
 * Generate candidate slugs for the current month's NYC precipitation
 * event. Polymarket's naming has been consistent ("precipitation-in-nyc-
 * in-<month>") but may vary for new months. We try the canonical form
 * first, then year-suffixed and alternative naming patterns.
 */
function candidateSlugs(now: Date = new Date()): string[] {
  const month = now.toLocaleString("en-US", { month: "long" }).toLowerCase();
  const year = now.getUTCFullYear();
  return [
    `precipitation-in-nyc-in-${month}`,
    `precipitation-in-nyc-in-${month}-${year}`,
    `nyc-precipitation-${month}`,
    `nyc-precipitation-${month}-${year}`,
    `precipitation-nyc-${month}`,
    `precipitation-nyc-${month}-${year}`,
    `nyc-rainfall-${month}`,
    `nyc-rainfall-${month}-${year}`,
  ];
}

interface GammaMarket {
  // Polymarket Gamma `markets[]` shape (subset used here).
  question?: string;
  groupItemTitle?: string;
  outcomes?: string; // JSON-encoded ["Yes","No"]
  clobTokenIds?: string; // JSON-encoded [yesTokenId, noTokenId]
  lastTradePrice?: number | string | null;
  volume?: number | string | null;
  volumeNum?: number | null;
  [key: string]: unknown;
}

interface GammaEvent {
  slug: string;
  title?: string;
  markets: GammaMarket[];
  [key: string]: unknown;
}

interface ClobBookLevel {
  price: string;
  size: string;
}

interface ClobBook {
  bids?: ClobBookLevel[];
  asks?: ClobBookLevel[];
  [key: string]: unknown;
}

/**
 * Parse a Polymarket price (0-1 dollars) into cents (0-100).
 * Returns null if the value is missing, non-numeric, or <= 0.
 */
function dollarsToCents(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function parseJsonField<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Given a bucket label like "<2", "2-3", "3-4", ">6", compute the
 * numeric lower/upper bounds in inches. Open-ended buckets use null
 * on the unbounded side.
 */
function parseBucketBounds(
  label: string,
): { lowerBound: number | null; upperBound: number | null } | null {
  const s = label.trim();
  const lessMatch = s.match(/^<\s*(\d+(?:\.\d+)?)/);
  if (lessMatch) {
    return { lowerBound: null, upperBound: parseFloat(lessMatch[1]) };
  }
  const moreMatch = s.match(/^>\s*(\d+(?:\.\d+)?)/);
  if (moreMatch) {
    return { lowerBound: parseFloat(moreMatch[1]), upperBound: null };
  }
  const rangeMatch = s.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    return {
      lowerBound: parseFloat(rangeMatch[1]),
      upperBound: parseFloat(rangeMatch[2]),
    };
  }
  return null;
}

/**
 * Derive a canonical bucket label from a Polymarket market's
 * question/groupItemTitle. Polymarket typically publishes these in
 * formats like "Less than 2 inches", "Between 2 and 3 inches",
 * "More than 6 inches", or compact "<2", "2-3", ">6".
 */
function canonicalBucketLabel(raw: string): string | null {
  const s = raw.toLowerCase();
  // Compact tokens first (handles "<2", "2-3", ">6")
  const compactLess = s.match(/<\s*(\d+(?:\.\d+)?)/);
  if (compactLess) return `<${compactLess[1]}`;
  const compactMore = s.match(/>\s*(\d+(?:\.\d+)?)/);
  if (compactMore) return `>${compactMore[1]}`;
  const compactRange = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (compactRange) return `${compactRange[1]}-${compactRange[2]}`;
  // Verbose variants
  if (/less than|under|below/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    if (m) return `<${m[1]}`;
  }
  if (/more than|greater than|above|over/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    if (m) return `>${m[1]}`;
  }
  if (/between|-|–|to /.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}

async function fetchClobBook(
  tokenId: string,
  log: string[],
): Promise<{ yesBid: number | null; yesAsk: number | null }> {
  const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!resp.ok) {
      log.push(`[polymarket] CLOB book ${tokenId.slice(0, 10)}…: ${resp.status}`);
      return { yesBid: null, yesAsk: null };
    }
    const book = (await resp.json()) as ClobBook;
    let yesBid: number | null = null;
    let yesAsk: number | null = null;
    if (book.bids && book.bids.length > 0) {
      // Highest bid wins — CLOB returns levels unordered in some envs.
      const prices = book.bids
        .map((b) => parseFloat(b.price))
        .filter((p) => Number.isFinite(p) && p > 0);
      if (prices.length > 0) yesBid = Math.round(Math.max(...prices) * 100);
    }
    if (book.asks && book.asks.length > 0) {
      const prices = book.asks
        .map((a) => parseFloat(a.price))
        .filter((p) => Number.isFinite(p) && p > 0);
      if (prices.length > 0) yesAsk = Math.round(Math.min(...prices) * 100);
    }
    return { yesBid, yesAsk };
  } catch (e) {
    log.push(
      `[polymarket] CLOB book ${tokenId.slice(0, 10)}… error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { yesBid: null, yesAsk: null };
  }
}

async function trySlug(
  slug: string,
  log: string[],
): Promise<{ event: GammaEvent | null; httpStatus: number | null; error?: string }> {
  const eventUrl = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
  try {
    const resp = await fetch(eventUrl, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!resp.ok) {
      log.push(`[polymarket] slug="${slug}" → HTTP ${resp.status}`);
      return { event: null, httpStatus: resp.status };
    }
    const data = (await resp.json()) as GammaEvent[] | GammaEvent;
    const events = Array.isArray(data) ? data : [data];
    const event = events.find((e) => e?.slug === slug) ?? events[0] ?? null;
    if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
      log.push(`[polymarket] slug="${slug}" → OK but 0 markets`);
      return { event: null, httpStatus: resp.status };
    }
    log.push(`[polymarket] slug="${slug}" → found ${event.markets.length} markets`);
    return { event, httpStatus: resp.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`[polymarket] slug="${slug}" → error: ${msg}`);
    return { event: null, httpStatus: null, error: msg };
  }
}

/**
 * Fetch the Polymarket NYC monthly rainfall event and return its
 * bucket outcomes with live YES bid/ask in cents. Tries multiple slug
 * candidates when the primary slug returns no markets; pass an explicit
 * slug to skip the fallback search.
 */
export async function fetchPolymarketNYC(
  log: string[] = [],
  slug?: string,
): Promise<PolymarketApiResponse> {
  const slugsToTry = slug ? [slug] : candidateSlugs();
  log.push(`[polymarket] Trying ${slugsToTry.length} slug candidate(s): ${slugsToTry.join(", ")}`);

  let event: GammaEvent | null = null;
  let matchedSlug = slugsToTry[0];
  const slugsAttempted: string[] = [];

  for (const candidate of slugsToTry) {
    slugsAttempted.push(candidate);
    const result = await trySlug(candidate, log);
    if (result.event) {
      event = result.event;
      matchedSlug = candidate;
      break;
    }
  }

  if (!event) {
    const now = new Date();
    const monthLabel = now.toLocaleString("en-US", { month: "long" });
    log.push(`[polymarket] No event found after trying all ${slugsAttempted.length} slugs`);
    return {
      outcomes: [],
      fetchedAt: new Date().toISOString(),
      slug: matchedSlug,
      slugsAttempted,
      error: `not_found`,
      errorDetail: `NYC ${monthLabel} market not yet listed on Polymarket`,
      log,
    };
  }

  log.push(
    `[polymarket] Event "${event.title ?? slug}" has ${event.markets.length} markets`,
  );

  // Log every raw bucket label so we can spot a Polymarket format
  // change (e.g., new May bin boundaries) and update the parser.
  for (const m of event.markets) {
    const raw = m.groupItemTitle ?? m.question ?? "";
    const canon = canonicalBucketLabel(raw);
    log.push(
      `[polymarket] raw bucket label: "${raw}" → canonical: ${canon ?? "UNPARSED"}`,
    );
  }

  const outcomes: PolymarketOutcome[] = [];

  for (const market of event.markets) {
    const rawLabel = market.groupItemTitle ?? market.question ?? "";
    const label = canonicalBucketLabel(rawLabel);
    if (!label) {
      log.push(`[polymarket] Could not parse bucket from: "${rawLabel}"`);
      continue;
    }
    const bounds = parseBucketBounds(label);
    if (!bounds) {
      log.push(`[polymarket] Could not parse bounds for: "${label}"`);
      continue;
    }

    const tokens = parseJsonField<string[]>(market.clobTokenIds);
    const yesTokenId = tokens && tokens.length > 0 ? tokens[0] : null;
    if (!yesTokenId) {
      log.push(`[polymarket] Missing clob token for bucket ${label}`);
      continue;
    }

    const { yesBid, yesAsk } = await fetchClobBook(yesTokenId, log);
    const lastPrice = dollarsToCents(market.lastTradePrice);
    const volRaw =
      typeof market.volumeNum === "number"
        ? market.volumeNum
        : typeof market.volume === "number"
          ? market.volume
          : parseFloat(String(market.volume ?? "0"));
    const volume = Number.isFinite(volRaw) ? Math.round(volRaw) : 0;

    outcomes.push({
      label,
      lowerBound: bounds.lowerBound,
      upperBound: bounds.upperBound,
      yesBid,
      yesAsk,
      lastPrice,
      volume,
    });

    log.push(
      `[polymarket] ${label}: yesBid=${yesBid}c yesAsk=${yesAsk}c last=${lastPrice}c vol=${volume}`,
    );
  }

  // Sort outcomes by lowerBound so the panel renders in bucket order.
  outcomes.sort((a, b) => {
    const la = a.lowerBound ?? -Infinity;
    const lb = b.lowerBound ?? -Infinity;
    return la - lb;
  });

  return {
    outcomes,
    fetchedAt: new Date().toISOString(),
    slug: matchedSlug,
    slugsAttempted,
    log,
  };
}

export async function fetchPolymarketNYCDirect(): Promise<PolymarketApiResponse> {
  const log: string[] = [];
  log.push(`[polymarket] Direct fetch at ${new Date().toISOString()}`);
  const resp = await fetchPolymarketNYC(log);
  for (const line of log) console.log(line);
  return resp;
}

export interface PolymarketSearchResult {
  slug: string;
  title: string;
  marketsCount: number;
}

export async function searchPolymarketEvents(
  query: string,
): Promise<{ results: PolymarketSearchResult[]; error?: string }> {
  const url = `${GAMMA_BASE}/events?active=true&closed=false&limit=20&search=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!resp.ok) {
      return { results: [], error: `gamma search ${resp.status}` };
    }
    const data = (await resp.json()) as GammaEvent[];
    const events = Array.isArray(data) ? data : [data];
    return {
      results: events.map((e) => ({
        slug: e.slug,
        title: e.title ?? e.slug,
        marketsCount: Array.isArray(e.markets) ? e.markets.length : 0,
      })),
    };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : String(e) };
  }
}
