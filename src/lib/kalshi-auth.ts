import crypto from "crypto";

/**
 * Shared Kalshi RSA-PSS request signing. Used by both /api/fetch-kalshi
 * (public market data) and /api/fetch-portfolio (private positions).
 *
 * When KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY env vars are present, every
 * request is signed per Kalshi's spec: `timestamp_ms + METHOD + path`
 * where `path` is the full URL path incl. `/trade-api/v2/...` and query
 * string. Without those env vars, callers skip the three KALSHI-ACCESS-*
 * headers (unauthenticated market endpoints still work).
 */

export const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID;

// Normalize PEM: Vercel-style env vars often store newlines as literal
// "\n" escape sequences, which breaks crypto.createPrivateKey().
export const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY
  ? process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n")
  : undefined;

export const HAS_AUTH = !!(KALSHI_API_KEY_ID && KALSHI_PRIVATE_KEY);

export const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Path prefix that must be included in the signed message.
export const KALSHI_API_PATH_PREFIX = "/trade-api/v2";

export interface KalshiAuthHeaders {
  timestamp: string;
  signature: string;
  keyId: string;
  signInput: string;
}

/**
 * Compute Kalshi RSA-PSS auth headers for a given method + path. Returns
 * null in unauthenticated mode so callers can skip adding the headers.
 *
 * The signed message uses only the path portion *without* any query
 * string — e.g. `/trade-api/v2/portfolio/positions`, not
 * `/trade-api/v2/portfolio/positions?status=open`. The full path
 * (including the query string) is still sent in the actual request URL;
 * only the signature input strips it.
 */
export function signKalshiRequest(
  method: string,
  path: string,
): KalshiAuthHeaders | null {
  if (!HAS_AUTH) return null;
  const timestamp = Date.now().toString();
  const upperMethod = method.toUpperCase();
  const pathWithoutQuery = path.split("?")[0];
  const signInput =
    timestamp + upperMethod + KALSHI_API_PATH_PREFIX + pathWithoutQuery;
  const privateKey = crypto.createPrivateKey(KALSHI_PRIVATE_KEY as string);
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signInput), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    timestamp,
    signature: signature.toString("base64"),
    keyId: KALSHI_API_KEY_ID as string,
    signInput,
  };
}

/**
 * Attach the three KALSHI-ACCESS-* headers onto a header map when
 * authenticated. Returns the auth object (for debug logging) or null.
 */
export function attachKalshiAuthHeaders(
  headers: Record<string, string>,
  method: string,
  path: string,
): KalshiAuthHeaders | null {
  const auth = signKalshiRequest(method, path);
  if (!auth) return null;
  headers["KALSHI-ACCESS-KEY"] = auth.keyId;
  headers["KALSHI-ACCESS-TIMESTAMP"] = auth.timestamp;
  headers["KALSHI-ACCESS-SIGNATURE"] = auth.signature;
  return auth;
}
