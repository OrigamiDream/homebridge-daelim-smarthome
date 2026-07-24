import { jsonRoute } from "@/lib/api";
import { getSessionSummary, initializeFromEnvironment } from "@/lib/smart-elife/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonRoute(async () => {
    const environment = await initializeFromEnvironment();
    return {
      ok: true,
      provider: "smart-elife",
      dashboard: "ready",
      environment,
      session: getSessionSummary(),
    };
  });
}
