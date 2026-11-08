import type { AccountId } from "@/lib/account";

/** Stored user id that must already be verified before that account may follow or unfollow. */
export const ACCOUNT_USER_ID: Record<AccountId, string> = {
  1: "1933586991612080128",
  2: "1468479269701820422",
};

/** Account 1 only. These seven ids stay blocked and are not copied onto account 2. */
export const UNFOLLOW_WHITELIST: ReadonlySet<string> = new Set([
  "25073877",
  "44196397",
  "902839045356744704",
  "1222182756400037889",
  "902926941413453824",
  "1003840309166366721",
  "2985599460",
]);

/** Account 2 has no confirmed whitelist yet. It stays empty until one is explicitly configured. */
export const ACCOUNT2_UNFOLLOW_WHITELIST: ReadonlySet<string> = new Set();

export function unfollowWhitelist(accountId: AccountId): ReadonlySet<string> {
  return accountId === 1 ? UNFOLLOW_WHITELIST : ACCOUNT2_UNFOLLOW_WHITELIST;
}

export function unfollowEnabled(accountId: AccountId): boolean {
  const name = accountId === 1 ? "XUTIE_ACCOUNT1_UNFOLLOW" : "XUTIE_ACCOUNT2_UNFOLLOW";
  return process.env[name] === "on";
}

export function followEnabled(accountId: AccountId): boolean {
  const name = accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW";
  return process.env[name] === "on";
}

export type Audience = "zh" | "en";

export function audienceFor(accountId: AccountId): Audience {
  return accountId === 1 ? "zh" : "en";
}
