import { jsonRoute } from "@/lib/api";
import { getSettings } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonRoute(() => ({ ok: true, settings: getSettings() }));
}
