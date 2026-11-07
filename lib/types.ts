export type TweetStatus = "pending" | "posted" | "failed";

/** Why a failed or blocked post looks the way it does. Unknown legacy rows are classified from the saved message. */
export type FailureClass = "credits" | "rate_limit" | "auth" | "duplicate" | "other";

/**
 * What the queue is doing right now.
 * `idle` is a drained queue (pending 0 with history). It is not a sender failure.
 * `empty` means there are no rows at all. `paused` is a stop the operator or an auth/credential error asked for.
 */
export type ServicePhase =
  | "empty"
  | "idle"
  | "paused"
  | "no_credentials"
  | "auth_blocked"
  | "credits_waiting"
  | "rate_limited"
  | "scheduled"
  | "due";

export type SchedulerLiveness = "unknown" | "recent" | "stale";

export type ActivityReport = {
  phase: ServicePhase;
  /** Set only when X or credentials are blocking sends. An empty or waiting queue is not a fault. */
  fault: null | "no_credentials" | "auth" | "credits" | "rate_limit";
  pending: number;
  posted: number;
  failed: number;
  /** Rows that are not pending, posted, or failed, such as a cancelled post. They are never auto-queued. */
  other: number;
  dueCount: number;
  nextScheduledAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessTweetId: string | null;
  blockUntil: string | null;
  lastError: string | null;
  lastTickAt: string | null;
  lastTickAction: string | null;
  scheduler: SchedulerLiveness;
  failureKinds: Record<FailureClass, number>;
};

export type DelayReason = "manual" | null;

export type Credentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export type XUser = {
  id: string;
  username: string;
  name: string;
};

export type Tweet = {
  id: string;
  text: string;
  weightedLength: number;
  status: TweetStatus;
  scheduledAt: string;
  postedAt: string | null;
  tweetId: string | null;
  errorMessage: string | null;
  /** Stable class for a failure (`duplicate`, `credits`, …). Null on older rows; the message is still used to classify them. */
  errorKind: string | null;
  attemptCount: number;
  sortOrder: number;
  delayReason: DelayReason;
  /** Optional media + thread replies for this queue item (the whole thread counts as one post). */
  extra?: TweetExtra | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadPost = { text: string; media?: string[]; tweetId?: string | null };

export type TweetExtra = {
  /** Local image paths attached to the head post. */
  media?: string[];
  /** Reply posts sent right after the head, each replying to the previous one. */
  thread?: ThreadPost[];
  /** Set once the head has gone out (resume point if a reply fails). */
  headTweetId?: string | null;
};

export type PublicTweet = Tweet & {
  tweetUrl: string | null;
  /** Over 280 weighted characters: needs X Premium. */
  isLong: boolean;
  /** Present when this row has an error. Posted rows with a cleared error stay null. */
  failureClass: FailureClass | null;
};

export type QueueSettings = {
  intervalMinutes: number;
  /** Each gap is interval + a uniform random extra delay in [min, max] seconds. */
  randomMinSeconds: number;
  randomMaxSeconds: number;
  paused: boolean;
  pauseReason: string | null;
  rateLimitUntil: string | null;
  lastError: string | null;
  /** When the scheduler last finished a check. Null until this build has recorded one. */
  lastTickAt: string | null;
  lastTickAction: string | null;
};

export type PublicState = {
  mockMode: boolean;
  credentialsConfigured: boolean;
  account: { username: string; displayName: string; userId: string } | null;
  queue: QueueSettings;
  counts: { pending: number; posted: number; failed: number };
  /** Service and queue diagnosis. Derived locally; it does not call X. */
  activity: ActivityReport;
  tweets: PublicTweet[];
};

export type InvalidTweet = {
  index: number;
  text: string;
  weightedLength: number;
  reason: "empty" | "too_long";
};

export type ImportMode = "lines" | "paragraphs" | "separator" | "csv";
