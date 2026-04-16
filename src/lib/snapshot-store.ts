import { put, list, get } from "@vercel/blob";
import { ForecastSnapshot } from "./convergence";

/**
 * Server-side snapshot storage backed by Vercel Blob — **append-only**.
 *
 * Each snapshot is written to its own uniquely-keyed blob:
 *
 *     snapshots/YYYY-MM-DDTHH-MM-SS-sssZ.json
 *
 * (colons and the decimal dot in the ISO timestamp are replaced by
 * hyphens so the key is a clean path segment.)
 *
 * Reads list all blobs under the "snapshots/" prefix, filter by the
 * 7-day retention window, sort lexicographically (== chronologically
 * thanks to the ISO naming), and return up to `limit` newest entries.
 *
 * BLOB_READ_WRITE_TOKEN is expected to be set in the Vercel environment;
 * if missing (local dev without token), Blob operations are skipped.
 */

const BLOB_PREFIX = "snapshots/";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Convert an ISO timestamp to a blob-key-safe string.
 *   "2026-04-15T18:30:45.123Z" → "2026-04-15T18-30-45-123Z"
 */
function timestampToKey(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Reverse the key transform to recover an ISO timestamp for date parsing.
 *   "2026-04-15T18-30-45-123Z" → "2026-04-15T18:30:45.123Z"
 */
function keyToTimestamp(stem: string): string {
  // Match the time portion: T followed by HH-MM-SS-mmmZ
  return stem.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
    "T$1:$2:$3.$4Z",
  );
}

/**
 * Return true if `pathname` looks like a per-snapshot key (as opposed
 * to other blobs like last-model-run.json that share the prefix).
 */
function isSnapshotKey(pathname: string): boolean {
  const stem = pathname.replace(BLOB_PREFIX, "").replace(".json", "");
  const iso = keyToTimestamp(stem);
  return !isNaN(new Date(iso).getTime());
}

/**
 * Append a single snapshot to Vercel Blob as a new, uniquely-keyed
 * object. This never overwrites existing snapshots — each call creates
 * a new blob.
 */
export async function saveServerSnapshot(
  snapshot: ForecastSnapshot,
): Promise<void> {
  if (!hasBlobToken()) {
    console.warn(`[snapshot] No BLOB_READ_WRITE_TOKEN — skipping save`);
    return;
  }
  const key = `${BLOB_PREFIX}${timestampToKey(snapshot.timestamp)}.json`;
  const bodySize = JSON.stringify(snapshot).length;
  console.log(`[snapshot] Saving blob: ${key} (${bodySize} bytes)`);
  try {
    await put(key, JSON.stringify(snapshot), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true, // harmless — key already unique per timestamp
    });
    console.log(`[snapshot] Saved blob: ${key}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[snapshot] Blob save failed: ${msg}`);
    throw new Error(`Blob save failed: ${msg}`);
  }
}

/**
 * Load server snapshots from Vercel Blob, returned in chronological
 * order (oldest first).
 *
 * Lists all blob keys under "snapshots/", filters to valid snapshot
 * keys within the 7-day retention window, sorts chronologically, takes
 * the most recent `limit` entries, and fetches each blob's content in
 * parallel.
 *
 * @param limit  Maximum number of snapshots to return (default 100).
 */
export async function loadServerSnapshots(
  limit: number = 100,
): Promise<ForecastSnapshot[]> {
  if (!hasBlobToken()) {
    console.warn(`[snapshot] No BLOB_READ_WRITE_TOKEN — returning empty`);
    return [];
  }

  const cutoff = Date.now() - MAX_AGE_MS;

  // Collect all snapshot-shaped blob entries under the prefix.
  const entries: { url: string; pathname: string }[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix: BLOB_PREFIX,
        limit: 1000,
        cursor,
      });
      for (const blob of page.blobs) {
        if (!isSnapshotKey(blob.pathname)) continue;
        // Quick age check from the key to avoid fetching ancient blobs.
        const stem = blob.pathname.replace(BLOB_PREFIX, "").replace(".json", "");
        const ts = new Date(keyToTimestamp(stem)).getTime();
        if (Number.isFinite(ts) && ts > cutoff) {
          entries.push({ url: blob.url, pathname: blob.pathname });
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.warn(
      `[snapshot] Blob list failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }

  if (entries.length === 0) return [];

  // Sort chronologically (lexicographic on ISO-based keys), take newest.
  entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
  const newest = entries.slice(-limit);

  // Fetch each blob's content in parallel via the SDK's get().
  const results = await Promise.allSettled(
    newest.map(async ({ url }) => {
      const result = await get(url, { access: "private" });
      if (!result) return null;
      const data = await new Response(result.stream).json();
      return data as ForecastSnapshot;
    }),
  );

  const snapshots: ForecastSnapshot[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      snapshots.push(r.value);
    }
  }

  return snapshots;
}
