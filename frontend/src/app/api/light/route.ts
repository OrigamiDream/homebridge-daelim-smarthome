import { NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api";
import { setLight } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return jsonRoute(async () => {
    const body = await request.json();
    const deviceId = String(body.deviceId ?? "").trim();
    if (!deviceId || typeof body.on !== "boolean") {
      throw new Error("A device ID and boolean on state are required.");
    }
    return setLight(deviceId, body.on);
  });
}
