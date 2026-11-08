import { accountIdFrom } from "@/lib/account";
import { apiMode } from "@/lib/deployment";
import { handle, readJson } from "@/lib/http";
import { account1LiveHooks } from "@/lib/unfollow-live";
import { listUnfollowAudit, requireUnfollowAccount, submitUnfollowBatch, type UnfollowHooks } from "@/lib/unfollow-queue";

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

/** Read batch audit pages. Does not call X. */
export function GET(request: Request) {
  return handle(() => {
    requireUnfollowAccount(accountIdFrom(request));
    return listUnfollowAudit(auditQuery(request));
  });
}

/** One half-hour batch for account 1. Does not import candidates and does not touch the post queue. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    requireUnfollowAccount(accountIdFrom(request, body));
    const injected = process.env.VITEST ? testHooks() : undefined;
    if (injected) return submitUnfollowBatch({ hooks: injected });
    if (apiMode() !== "live") return submitUnfollowBatch();
    return submitUnfollowBatch({ hooks: account1LiveHooks() });
  });
}
