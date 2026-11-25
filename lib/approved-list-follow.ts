import type { AccountId } from "@/lib/account";
import { account1OperatorListed } from "@/lib/follow-allowlist";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

export { approvedListFollowPutBody } from "@/lib/approved-list-follow-body";

export type ApprovedListFollowView = {
  approvedListFollow: boolean;
  approvedListFollowLocked: boolean;
  approvedListStatus: string;
};

const OFF_STATUS = "关闭：账号1仍按原资格筛选。缺新鲜证据、非蓝V、非中文或未通过资格的人会跳过，不会关注。";
const ON_STATUS = "开启：账号1执行白名单上的已筛名单，只跳过永久取关黑名单和已经关注过的人。不因为缺证据、不是蓝V、不是中文或资格未过而跳过。不在这份白名单上的人仍按原筛选。节奏、每日上限和当天授权不变。";
const LOCKED_STATUS = "账号2没有已筛名单开关，仍按原资格筛选。发现来的人不能把自己标成已筛名单。";

export function approvedListFollowEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT approved_list_follow FROM follow_account_config WHERE account_id = 1")
    .get() as { approved_list_follow: number | null } | undefined;
  return row?.approved_list_follow === 1;
}

/**
 * Account 1 operator list only. A reserve or evidence payload cannot set this.
 * The switch defaults off, so missing config stays on the original screens.
 */
export function account1ApprovedListWaivesScreening(targetUserId: string): boolean {
  return approvedListFollowEnabled() && account1OperatorListed(targetUserId);
}

export function approvedListFollowView(accountId: AccountId): ApprovedListFollowView {
  if (accountId !== 1) {
    return { approvedListFollow: false, approvedListFollowLocked: true, approvedListStatus: LOCKED_STATUS };
  }
  const enabled = approvedListFollowEnabled();
  return {
    approvedListFollow: enabled,
    approvedListFollowLocked: false,
    approvedListStatus: enabled ? ON_STATUS : OFF_STATUS,
  };
}

/** Persists the account 1 switch. The config row must already exist. Does not touch reserve or evidence. */
export function persistApprovedListFollow(accountId: AccountId, value: unknown): void {
  if (accountId !== 1) throw new AppError("approved_list_locked", "已筛名单开关只属于账号1。", 400);
  if (typeof value !== "boolean") throw new AppError("invalid_approved_list", "approvedListFollow 必须是布尔值。");
  const existing = getDb().prepare("SELECT account_id FROM follow_account_config WHERE account_id = 1").get();
  if (!existing) throw new AppError("missing_config", "请先保存账号1的关键词，再改已筛名单开关。", 400);
  getDb()
    .prepare("UPDATE follow_account_config SET approved_list_follow = ?, updated_at = ? WHERE account_id = 1")
    .run(value ? 1 : 0, new Date().toISOString());
}
