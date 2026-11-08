import { accountIdFrom } from "@/lib/account";
import { apiMode } from "@/lib/deployment";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { account1LiveHooks } from "@/lib/unfollow-live";
import {
  getUnfollowStatus,
  importUnfollowCandidates,
  requireUnfollowAccount,
  submitUnfollowBatch,
  type UnfollowHooks,
} from "@/lib/unfollow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function testHooks(): UnfollowHooks | null {
  if (!process.env.VITEST) return null;
  return (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks ?? null;
}

function productionBatch() {
  if (apiMode() !== "live") return submitUnfollowBatch();
  return submitUnfollowBatch({ hooks: account1LiveHooks() });
}

export function GET(request: Request) {
  return handle(() => {
    requireUnfollowAccount(accountIdFrom(request));
    return getUnfollowStatus();
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    requireUnfollowAccount(accountId);
    if (body.candidates !== undefined) {
      if (!Array.isArray(body.candidates)) throw new AppError("invalid_json", "候选名单格式不正确。");
      return importUnfollowCandidates({ candidates: body.candidates });
    }
    const injected = process.env.VITEST ? testHooks() : null;
    if (injected) return submitUnfollowBatch({ hooks: injected });
    return productionBatch();
  });
}
