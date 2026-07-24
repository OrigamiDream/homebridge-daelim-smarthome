import { jsonRoute } from "@/lib/api";
import { callElevator } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function POST() {
  return jsonRoute(callElevator);
}
