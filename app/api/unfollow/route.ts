import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { AppError } from "@/lib/errors";
import {
  getUnfollowStatus,
  importUnfollowCandidates,
  requireUnfollowAccount,
  submitUnfollowBatch,
  type UnfollowHooks,
} from "@/lib/unfollow-queue";
import { inspectTarget, unfollowTarget } from "@/lib/unfollow-live";
import { ACCOUNT1_UNFOLLOW_USER_ID } from "@/lib/unfollow-policy";
import { getCredentialsRow } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function testHooks(): UnfollowHooks | null {
  if (!process.env.VITEST) return null;
  return (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks ?? null;
}

function liveHooks(): UnfollowHooks {
  const sourceUserId = getCredentialsRow(1)?.user_id;
  if (sourceUserId !== ACCOUNT1_UNFOLLOW_USER_ID) {
    throw new AppError("identity_unconfirmed", "账号1尚未确认是指定账号，不会取关。", 409);
  }
  return {
    inspect: (targetUserId) => inspectTarget(sourceUserId, targetUserId),
    unfollow: (targetUserId) => unfollowTarget(sourceUserId, targetUserId),
  };
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
    const hooks = testHooks() ?? (process.env.VITEST ? null : liveHooks());
    return submitUnfollowBatch({ hooks: hooks ?? undefined });
  });
}
