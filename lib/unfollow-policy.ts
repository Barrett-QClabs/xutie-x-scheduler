/** Official user-context checks used before an unfollow. Missing fields stay unknown. */
export const ACCOUNT1_UNFOLLOW_USER_ID = "1933586991612080128";

export const UNFOLLOW_BATCH_LIMIT = 10;

export const FOLLOW_BATCH_LIMIT = 10;

export const FOLLOW_DAILY_CAP = 380;

export const MAX_FOLLOWERS = 20_000;

/** Newest public post, including replies and reposts, must be inside this window for a new follow. */
export const RECENT_ACTIVITY_MS = 12 * 60 * 60 * 1000;

export { UNFOLLOW_WHITELIST, ACCOUNT2_UNFOLLOW_WHITELIST } from "@/lib/automation-account";

/** A candidate is inactive only when the newest public post is strictly older than this. */
export const INACTIVE_AFTER_MS = 48 * 60 * 60 * 1000;

/** Unfollow evidence is trusted for at most 25 hours after observed_at. */
export const UNFOLLOW_EVIDENCE_MAX_MS = 25 * 60 * 60 * 1000;

/** Following-list position 1 is the shallowest. Only a rank past this skips the 72-hour check. */
export const SHALLOW_FOLLOWING_DEPTH = 1000;

/** Plugin pages are 25 people. Page 41 therefore starts at rank 1001. */
export const FOLLOWING_PAGE_SIZE = 25;

/** A reserve row older than one follow cycle cannot be acted on until it is stocked again. */
export const RESERVE_FRESH_MS = 45 * 60 * 1000;
