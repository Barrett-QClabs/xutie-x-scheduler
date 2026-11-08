/** Official user-context checks used before an account-1 unfollow. Missing fields stay unknown. */
export const ACCOUNT1_UNFOLLOW_USER_ID = "1933586991612080128";

export const UNFOLLOW_BATCH_LIMIT = 14;

/** A candidate is inactive only when the newest public post is strictly older than this. */
export const INACTIVE_AFTER_MS = 48 * 60 * 60 * 1000;

export const UNFOLLOW_WHITELIST: ReadonlySet<string> = new Set([
  "25073877",
  "44196397",
  "902839045356744704",
  "1222182756400037889",
  "902926941413453824",
  "1003840309166366721",
  "2985599460",
]);
