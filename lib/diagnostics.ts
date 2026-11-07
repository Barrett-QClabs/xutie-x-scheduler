import { SCHEDULER_STALE_MS } from "@/lib/constants";
import type { ActivityReport, FailureClass, QueueSettings, ServicePhase, Tweet } from "@/lib/types";
import { classifyStatus, type XErrorKind } from "@/lib/x-client";

type TweetLike = Pick<Tweet, "scheduledAt" | "postedAt" | "tweetId" | "errorMessage" | "errorKind"> & {
  status: string;
};

/**
 * Classify a stored failure. A saved kind wins. Older rows only have a message,
 * so the wording is used, and a row with neither stays "other".
 * This does not change the row.
 */
export function classifyStoredFailure(kind: string | null | undefined, message: string | null | undefined): FailureClass {
  if (kind === "credits" || kind === "rate_limit" || kind === "auth" || kind === "duplicate") return kind;
  if (kind === "transient" || kind === "rejected" || kind === "other") return "other";
  const text = (message ?? "").toLowerCase();
  if (!text.trim()) return "other";
  if (text.includes("duplicate")) return "duplicate";
  if (/credit|payment required|\b402\b|余额|额度不足/.test(text)) return "credits";
  if (/rate limit|too many requests|\b429\b|限频|限流/.test(text)) return "rate_limit";
  if (/premium|too long|character|length|长度|长文/.test(text)) return "other";
  if (/\b401\b|\b403\b|unauthorized|forbidden|oauth|token|credential|permission|not permitted|权限|凭据|认证/.test(text)) {
    return "auth";
  }
  return "other";
}

/** True for the two waits that share `rate_limit_until` but must not share a label. */
export function isTemporaryBlock(lastError: string | null): boolean {
  return lastError === "rate_limit" || lastError === "credits";
}

export function queuePolicy(kind: XErrorKind): {
  lastError: "credits" | "rate_limit" | "auth" | null;
  pauseQueue: boolean;
  keepPending: boolean;
  /** Duplicate and other per-post failures leave the rest of the queue free to take the later slots. */
  continueLaterPosts: boolean;
  wait: boolean;
} {
  switch (kind) {
    case "credits":
      return { lastError: "credits", pauseQueue: false, keepPending: true, continueLaterPosts: false, wait: true };
    case "rate_limit":
      return { lastError: "rate_limit", pauseQueue: false, keepPending: true, continueLaterPosts: false, wait: true };
    case "auth":
      return { lastError: "auth", pauseQueue: true, keepPending: true, continueLaterPosts: false, wait: false };
    case "duplicate":
      return { lastError: null, pauseQueue: false, keepPending: false, continueLaterPosts: true, wait: false };
    case "transient":
      return { lastError: null, pauseQueue: false, keepPending: true, continueLaterPosts: true, wait: false };
    default:
      return { lastError: null, pauseQueue: false, keepPending: false, continueLaterPosts: true, wait: false };
  }
}

/** Classify an HTTP result without contacting X. Status code wins over a conflicting message. */
export function diagnoseHttpStatus(status: number, message: string, body?: unknown) {
  const kind = classifyStatus(status, message, body ?? {});
  return { status, message, kind, ...queuePolicy(kind) };
}

export type MockScenarioId = "credits" | "rate_limit" | "auth" | "forbidden" | "duplicate" | "rejected" | "transient";

export type MockScenario = {
  id: MockScenarioId;
  /** Text marker the in-process mock client understands. It never leaves the machine. */
  marker: string;
  status: number;
  message: string;
};

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  {
    id: "credits",
    marker: "[[credits]]",
    status: 402,
    message: "Credits depleted. Your account does not have enough balance.",
  },
  { id: "rate_limit", marker: "[[rate-limit]]", status: 429, message: "Rate limit exceeded" },
  { id: "auth", marker: "[[auth]]", status: 401, message: "Invalid or expired token" },
  {
    id: "forbidden",
    marker: "[[forbidden]]",
    status: 403,
    message: "Forbidden: your token does not have permission to post.",
  },
  {
    id: "duplicate",
    marker: "[[duplicate]]",
    status: 403,
    message: "You are not allowed to create a Tweet with duplicate content.",
  },
  { id: "rejected", marker: "[[rejected]]", status: 400, message: "Invalid request" },
  { id: "transient", marker: "[[fail]]", status: 503, message: "Internal error" },
];

export function listMockScenarios() {
  return MOCK_SCENARIOS.map((scenario) => describeScenario(scenario));
}

export function describeMockScenario(id: string) {
  const scenario = MOCK_SCENARIOS.find((item) => item.id === id);
  return scenario ? describeScenario(scenario) : null;
}

function describeScenario(scenario: MockScenario) {
  return { id: scenario.id, marker: scenario.marker, ...diagnoseHttpStatus(scenario.status, scenario.message) };
}

/**
 * Explain the local queue. Pending 0 with history is `idle`, not a fault.
 * A missing heartbeat is `unknown`, not proof the process has stopped.
 * Rows that are not pending, posted, or failed are counted as `other` and left untouched.
 */
export function buildActivity(input: { now: Date; queue: QueueSettings; tweets: TweetLike[] }): ActivityReport {
  let pending = 0;
  let posted = 0;
  let failed = 0;
  let other = 0;
  const failureKinds: Record<FailureClass, number> = {
    credits: 0,
    rate_limit: 0,
    auth: 0,
    duplicate: 0,
    other: 0,
  };
  let nextScheduledAt: string | null = null;
  let dueCount = 0;
  let lastSuccessAt: string | null = null;
  let lastSuccessTweetId: string | null = null;

  for (const tweet of input.tweets) {
    if (tweet.status === "pending") {
      pending += 1;
      if (!nextScheduledAt || tweet.scheduledAt < nextScheduledAt) nextScheduledAt = tweet.scheduledAt;
      const at = new Date(tweet.scheduledAt).getTime();
      if (!Number.isNaN(at) && at <= input.now.getTime()) dueCount += 1;
    } else if (tweet.status === "posted") {
      posted += 1;
      if (tweet.postedAt && (!lastSuccessAt || tweet.postedAt > lastSuccessAt)) {
        lastSuccessAt = tweet.postedAt;
        lastSuccessTweetId = tweet.tweetId;
      }
    } else if (tweet.status === "failed") {
      failed += 1;
      failureKinds[classifyStoredFailure(tweet.errorKind, tweet.errorMessage)] += 1;
    } else {
      other += 1;
    }
  }

  const blockActive = Boolean(input.queue.rateLimitUntil) && new Date(input.queue.rateLimitUntil as string).getTime() > input.now.getTime();
  const phase = resolvePhase({
    queue: input.queue,
    pending,
    posted,
    failed,
    other,
    dueCount,
    blockActive,
  });

  return {
    phase,
    fault: faultFor(phase),
    pending,
    posted,
    failed,
    other,
    dueCount,
    nextScheduledAt,
    lastSuccessAt,
    lastSuccessTweetId,
    blockUntil: blockActive ? input.queue.rateLimitUntil : null,
    lastError: input.queue.lastError,
    lastTickAt: input.queue.lastTickAt,
    lastTickAction: input.queue.lastTickAction,
    scheduler: schedulerLiveness(input.queue.lastTickAt, input.now),
    failureKinds,
  };
}

function resolvePhase(input: {
  queue: QueueSettings;
  pending: number;
  posted: number;
  failed: number;
  other: number;
  dueCount: number;
  blockActive: boolean;
}): ServicePhase {
  if (input.queue.paused) {
    if (isCredentialPause(input.queue.pauseReason)) return "no_credentials";
    if (isAuthPause(input.queue)) return "auth_blocked";
    return "paused";
  }
  if (input.blockActive && input.queue.lastError === "credits") return "credits_waiting";
  if (input.blockActive) return "rate_limited";
  if (input.pending === 0 && input.posted === 0 && input.failed === 0 && input.other === 0) return "empty";
  if (input.pending === 0) return "idle";
  if (input.dueCount === 0) return "scheduled";
  return "due";
}

function faultFor(phase: ServicePhase): ActivityReport["fault"] {
  if (phase === "no_credentials") return "no_credentials";
  if (phase === "auth_blocked") return "auth";
  if (phase === "credits_waiting") return "credits";
  if (phase === "rate_limited") return "rate_limit";
  return null;
}

function isCredentialPause(reason: string | null): boolean {
  return reason === "missing_credentials" || reason === "decrypt_failed" || reason === "encryption_key_missing";
}

function isAuthPause(queue: QueueSettings): boolean {
  if (queue.lastError === "auth") return true;
  if (!queue.pauseReason || queue.pauseReason === "manual") return false;
  return classifyStoredFailure(null, queue.pauseReason) === "auth";
}

function schedulerLiveness(lastTickAt: string | null, now: Date): ActivityReport["scheduler"] {
  if (!lastTickAt) return "unknown";
  const at = new Date(lastTickAt).getTime();
  if (Number.isNaN(at)) return "unknown";
  return now.getTime() - at > SCHEDULER_STALE_MS ? "stale" : "recent";
}
