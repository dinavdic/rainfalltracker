import { NextRequest, NextResponse } from "next/server";
import { loadServerSnapshots } from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots?limit=N
 *
 * Lists server-side forecast snapshots from Vercel Blob, newest first.
 * Each snapshot lives under its own blob key
 * (snapshots/YYYY-MM-DDTHH-MM-SS-sssZ.json) so they accumulate
 * indefinitely (within the 7-day retention window).
 *
 * Query params:
 *   limit — max snapshots to return (default 100, max 1000).
 *
 * The Dashboard merges these with localStorage snapshots for the most
 * complete history.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    let limit = 100;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, 1000);
      }
    }

    // loadServerSnapshots returns chronological (oldest first).
    const snapshots = await loadServerSnapshots(limit);
    // Return newest first for the client.
    snapshots.reverse();

    return NextResponse.json({
      snapshots,
      count: snapshots.length,
    });
  } catch {
    return NextResponse.json({ snapshots: [], count: 0 });
  }
}
