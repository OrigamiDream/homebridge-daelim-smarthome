import { jsonRoute } from "@/lib/api";
import { getLogEntries } from "@/lib/smart-elife/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonRoute(() => ({ ok: true, logs: getLogEntries() }));
}
