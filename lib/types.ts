export type TweetStatus = "pending" | "posted" | "failed";

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
  createdAt: string;
  updatedAt: string;
};

export type PublicTweet = Tweet & {
  tweetUrl: string | null;
};

export type QueueSettings = {
  intervalMinutes: number;
  jitterMinutes: number;
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
