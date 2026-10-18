export type TweetStatus = "pending" | "posted" | "failed";

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
  attemptCount: number;
  sortOrder: number;
  delayReason: DelayReason;
  createdAt: string;
  updatedAt: string;
};

export type PublicTweet = Tweet & {
  tweetUrl: string | null;
  /** Over 280 weighted characters: needs X Premium. */
  isLong: boolean;
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
};

export type PublicState = {
  mockMode: boolean;
  credentialsConfigured: boolean;
  account: { username: string; displayName: string; userId: string } | null;
  queue: QueueSettings;
  counts: { pending: number; posted: number; failed: number };
  tweets: PublicTweet[];
};

export type InvalidTweet = {
  index: number;
  text: string;
  weightedLength: number;
  reason: "empty" | "too_long";
};

export type ImportMode = "lines" | "paragraphs" | "separator" | "csv";
