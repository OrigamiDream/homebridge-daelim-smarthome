import { jsonRoute } from "@/lib/api";
import { refreshDevices } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonRoute(async () => ({ ok: true, devices: await refreshDevices() }));
}
