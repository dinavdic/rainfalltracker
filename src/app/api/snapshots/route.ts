import { NextResponse } from "next/server";
import { loadServerSnapshots } from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots
 *
 * Returns all server-side forecast snapshots from Vercel Blob storage.
 * The Dashboard merges these with any localStorage snapshots to give
 * users full snapshot history even on first visit or new devices.
 *
 * No auth required — snapshot data is non-sensitive (aggregated
 * weather probabilities and public market prices).
 */
export async function GET() {
  try {
    const snapshots = await loadServerSnapshots();
    return NextResponse.json({
      snapshots,
      count: snapshots.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Return empty array rather than error — the dashboard should
    // degrade gracefully to localStorage-only snapshots
    console.error("[snapshots] Failed to load from Blob:", msg);
    return NextResponse.json({ snapshots: [], count: 0 });
  }
}
