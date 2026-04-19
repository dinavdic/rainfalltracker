import { NextRequest, NextResponse } from "next/server";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";
import { fetchRainfallDirect } from "@/lib/rainfall-fetcher";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("force") === "1";

  if (!forceRefresh) {
    const cached = await loadRainfallData();
    if (cached && isCacheFresh(cached)) {
      return NextResponse.json(cached);
    }
  }

  const response = await fetchRainfallDirect();

  try {
    await saveRainfallData(response);
  } catch {
    // Non-fatal
  }

  return NextResponse.json(response);
}
