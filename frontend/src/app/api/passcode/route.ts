import { NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api";
import { authorizePasscode } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return jsonRoute(async () => {
    const body = await request.json();
    const passcode = String(body.passcode ?? "").trim();
    if (!passcode) {
      throw new Error("Passcode is required.");
    }
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const credentials = username && password ? { username, password } : undefined;
    return authorizePasscode(passcode, credentials);
  });
}
