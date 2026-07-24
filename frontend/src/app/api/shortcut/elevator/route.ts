import { jsonRoute } from "@/lib/api";
import { callElevator } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "icn1";

export async function POST() {
  return jsonRoute(async () => {
    const result = await callElevator();
    return {
      ...result,
      action: "elevator",
      message: result.ok ? "Elevator call sent." : "Elevator call failed.",
    };
  });
}
