/** Client-safe request body. The persisted switch lives in approved-list-follow.ts. */
export function approvedListFollowPutBody(enabled: boolean): { accountId: 1; approvedListFollow: boolean } {
  return { accountId: 1, approvedListFollow: enabled };
}
