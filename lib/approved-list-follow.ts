import type { AccountId } from "@/lib/account";
import { followOperatorListed } from "@/lib/follow-allowlist";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

export { approvedListFollowPutBody } from "@/lib/approved-list-follow-body";

export type ApprovedListFollowView = {
  approvedListFollow: boolean;
  approvedListFollowLocked: boolean;
  approvedListStatus: string;
};

export function approvedListFollowEnabled(accountId: AccountId): boolean {
  const row = getDb()
    .prepare("SELECT approved_list_follow FROM follow_account_config WHERE account_id = ?")
    .get(accountId) as { approved_list_follow: number | null } | undefined;
  return row?.approved_list_follow === 1;
}

/**
 * Account-scoped operator list only. A reserve or evidence payload cannot set this.
 * The switch defaults off, so missing config stays on the original screens.
 */
export function approvedListWaivesScreening(accountId: AccountId, targetUserId: string): boolean {
  return approvedListFollowEnabled(accountId) && followOperatorListed(accountId, targetUserId);
}

export function approvedListFollowView(accountId: AccountId): ApprovedListFollowView {
  const enabled = approvedListFollowEnabled(accountId);
  const audience = accountId === 1 ? "中文" : "英文";
  return {
    approvedListFollow: enabled,
    approvedListFollowLocked: false,
    approvedListStatus: enabled
      ? `开启：账号${accountId}执行白名单上的已筛名单，只跳过永久取关黑名单和已经关注过的人。不因为缺证据、不是蓝V、不是${audience}或资格未过而跳过。不在这份白名单上的人仍按原筛选。节奏、每日上限和授权要求不变。`
      : `关闭：账号${accountId}仍按原资格筛选。缺新鲜证据、非蓝V、非${audience}或未通过资格的人会跳过，不会关注。`,
  };
}

/** Persists this account's switch. The config row must already exist. Does not touch reserve or evidence. */
export function persistApprovedListFollow(accountId: AccountId, value: unknown): void {
  if (typeof value !== "boolean") throw new AppError("invalid_approved_list", "approvedListFollow 必须是布尔值。");
  const existing = getDb().prepare("SELECT account_id FROM follow_account_config WHERE account_id = ?").get(accountId);
  if (!existing) throw new AppError("missing_config", `请先保存账号${accountId}的关键词，再改已筛名单开关。`, 400);
  getDb()
    .prepare("UPDATE follow_account_config SET approved_list_follow = ?, updated_at = ? WHERE account_id = ?")
    .run(value ? 1 : 0, new Date().toISOString(), accountId);
}
