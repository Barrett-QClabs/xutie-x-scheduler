import type { AccountId } from "@/lib/account";

/** Client-safe request body. The persisted switch lives in approved-list-follow.ts. */
export function approvedListFollowPutBody(accountId: AccountId, enabled: boolean): { accountId: AccountId; approvedListFollow: boolean } {
  return { accountId, approvedListFollow: enabled };
}
