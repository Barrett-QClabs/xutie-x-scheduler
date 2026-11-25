import { accountIdFrom } from "@/lib/account";
import { apiMode } from "@/lib/deployment";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { liveUnfollowHooks } from "@/lib/unfollow-live";
import { getUnfollowStatus, importUnfollowCandidates, submitUnfollowBatch, type UnfollowHooks } from "@/lib/unfollow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function testHooks(): UnfollowHooks | null {
  if (!process.env.VITEST) return null;
  return (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks ?? null;
}

export function GET(request: Request) {
  return handle(() => getUnfollowStatus(accountIdFrom(request)));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    if (body.candidates !== undefined) {
      if (!Array.isArray(body.candidates)) throw new AppError("invalid_json", "候选名单格式不正确。");
      return importUnfollowCandidates(accountId, { candidates: body.candidates });
    }
    const injected = process.env.VITEST ? testHooks() : null;
    if (injected) return submitUnfollowBatch({ accountId, hooks: injected });
    if (apiMode() !== "live") return submitUnfollowBatch({ accountId });
    return submitUnfollowBatch({ accountId, hooks: liveUnfollowHooks(accountId) });
  });
}
