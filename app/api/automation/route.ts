import { getAutomationStatus } from "@/lib/automation";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => ({
    ...getAutomationStatus(),
    scope: "shared" as const,
    accountScoped: false,
    accountId: null,
    requestedAccountId: new URL(request.url).searchParams.get("accountId"),
    appliedToAccount: false,
  }));
}
