import { getAutomationStatus } from "@/lib/automation";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handle(() => getAutomationStatus());
}
