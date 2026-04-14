import { promises as fs } from "fs";
import path from "path";
import { put, list } from "@vercel/blob";
import { ForecastSnapshot, appendSnapshot } from "./convergence";

/**
 * Server-side snapshot storage backed by Vercel Blob, with /tmp as a
 * warm-instance cache.
 *
 * Write path: append to the existing history, then persist to both
 * /tmp and Vercel Blob concurrently.
 *
 * Read path: try /tmp first (fast, warm instance), and fall back to
 * Blob on cold starts or instance recycling. Blob reads rehydrate /tmp
 * so subsequent calls on the same instance hit the fast path.
 *
 * BLOB_READ_WRITE_TOKEN is expected to be set in the Vercel environment;
 * if missing (local dev without token), Blob operations are skipped and
 * the store degrades to /tmp-only.
 */

const TMP_PATH = path.join("/tmp", "forecast-snapshots.json");
const BLOB_PATH = "snapshots/forecast-snapshots.json";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function filterByAge(data: unknown): ForecastSnapshot[] {
  if (!Array.isArray(data)) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return (data as ForecastSnapshot[]).filter(
    (s) => new Date(s.timestamp).getTime() > cutoff,
  );
}

/** Returns null if the /tmp file doesn't exist (cold start). */
async function loadFromTmp(): Promise<ForecastSnapshot[] | null> {
  try {
    const raw = await fs.readFile(TMP_PATH, "utf-8");
    return filterByAge(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadFromBlob(): Promise<ForecastSnapshot[]> {
  if (!hasBlobToken()) return [];
  try {
    const { blobs } = await list({ prefix: BLOB_PATH });
    const match = blobs.find((b) => b.pathname === BLOB_PATH);
    if (!match) return [];
    const resp = await fetch(match.url, { cache: "no-store" });
    if (!resp.ok) return [];
    const data = await resp.json();
    return filterByAge(data);
  } catch (e) {
    console.warn(
      `[snapshot-store] Blob load failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

async function saveToTmp(snapshots: ForecastSnapshot[]): Promise<void> {
  try {
    await fs.writeFile(TMP_PATH, JSON.stringify(snapshots));
  } catch {
    // non-fatal
  }
}

async function saveToBlob(snapshots: ForecastSnapshot[]): Promise<void> {
  if (!hasBlobToken()) return;
  try {
    await put(BLOB_PATH, JSON.stringify(snapshots), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    console.warn(
      `[snapshot-store] Blob save failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Load snapshots from /tmp first; on cold start (no /tmp file), fall back
 * to Vercel Blob and rehydrate /tmp for the rest of the instance's life.
 */
export async function loadServerSnapshots(): Promise<ForecastSnapshot[]> {
  const tmp = await loadFromTmp();
  if (tmp !== null) return tmp;

  const fromBlob = await loadFromBlob();
  if (fromBlob.length > 0) {
    // Warm the /tmp cache so subsequent reads on this instance skip Blob.
    await saveToTmp(fromBlob);
  }
  return fromBlob;
}

/**
 * Append a snapshot to the existing history and persist to both /tmp
 * and Vercel Blob. Dedup and pruning are handled by appendSnapshot().
 */
export async function saveServerSnapshot(
  snapshot: ForecastSnapshot,
): Promise<void> {
  const existing = await loadServerSnapshots();
  const updated = appendSnapshot(existing, snapshot);
  await Promise.all([saveToTmp(updated), saveToBlob(updated)]);
}
