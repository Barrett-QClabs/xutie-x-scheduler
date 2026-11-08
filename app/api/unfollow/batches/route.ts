import { accountIdFrom } from "@/lib/account";
import { apiMode } from "@/lib/deployment";
import { handle, readJson } from "@/lib/http";
import { liveUnfollowHooks } from "@/lib/unfollow-live";
import { listUnfollowAudit, submitUnfollowBatch, type UnfollowHooks } from "@/lib/unfollow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function testHooks(): UnfollowHooks | undefined {
  return (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks;
}

function auditQuery(request: Request): { limit?: number; before: string | null } {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const before = url.searchParams.get("before");
  return {
    limit: rawLimit === null ? undefined : Number(rawLimit),
    before: before === null || before === "" ? null : before,
  };
}

export function GET(request: Request) {
  return handle(() => listUnfollowAudit(accountIdFrom(request), auditQuery(request)));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    const injected = process.env.VITEST ? testHooks() : undefined;
    if (injected) return submitUnfollowBatch({ accountId, hooks: injected });
    if (apiMode() !== "live") return submitUnfollowBatch({ accountId });
    return submitUnfollowBatch({ accountId, hooks: liveUnfollowHooks(accountId) });
  });
}
