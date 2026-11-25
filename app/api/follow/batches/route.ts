import { accountIdFrom } from "@/lib/account";
import { apiMode } from "@/lib/deployment";
import { handle, readJson } from "@/lib/http";
import { liveFollowHooks } from "@/lib/follow-live";
import { listFollowAudit, submitFollowBatch, type FollowHooks } from "@/lib/follow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function testHooks(): FollowHooks | undefined {
  return (globalThis as { __xutiFollowHooks?: FollowHooks }).__xutiFollowHooks;
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
  return handle(() => listFollowAudit(accountIdFrom(request), auditQuery(request)));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    const injected = process.env.VITEST ? testHooks() : undefined;
    if (injected) return submitFollowBatch({ accountId, hooks: injected });
    if (apiMode() !== "live") return submitFollowBatch({ accountId });
    return submitFollowBatch({ accountId, hooks: liveFollowHooks(accountId) });
  });
}
