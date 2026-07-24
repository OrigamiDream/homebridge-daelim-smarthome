import { NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api";
import { signIn } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return jsonRoute(async () => {
    const body = await request.json();
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!username || !password) {
      throw new Error("Username and password are required.");
    }
    return signIn({
      username,
      password,
    });
  });
}
