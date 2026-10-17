import { getQueueSettings, patchQueueSettings, patchTweet, releaseLock, tryAcquireLock } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { deferExtraOverdue, nextDueTweet, pauseQueue, readCredentials } from "@/lib/service";
import type { XClient } from "@/lib/x-client";
import { createXClient, XApiError } from "@/lib/x-client";

export type TickResult =
  | { action: "paused" }
  | { action: "rate_limited"; until: string }
  | { action: "busy" }
  | { action: "idle" }
  | { action: "no_credentials" }
  | { action: "posted"; id: string; tweetId: string }
  | { action: "failed"; id: string }
  | { action: "auth_paused"; id: string }
  | { action: "retry_later"; id: string };

const globalState = globalThis as unknown as { __xutiScheduler?: boolean; __xutiTick?: Promise<unknown> };

export function startScheduler(): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (globalState.__xutiScheduler) return;
  globalState.__xutiScheduler = true;
  console.log("[序帖] 调度已启动，每 5 秒检查一次到点的帖子。");
  const timer = setInterval(() => {
    void tick().catch((error) => {
      console.error("[序帖] 调度失败", error instanceof Error ? error.message : error);
    });
  }, 5_000);
  timer.unref?.();
}

export function tick(options?: { now?: Date; client?: XClient; random?: () => number }): Promise<TickResult> {
  const previous = globalState.__xutiTick ?? Promise.resolve();
  const run = previous.then(() => tickOnce(options), () => tickOnce(options));
  globalState.__xutiTick = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function tickOnce(options?: { now?: Date; client?: XClient; random?: () => number }): Promise<TickResult> {
  const now = options?.now ?? new Date();
  const settings = getQueueSettings();
  if (settings.rateLimitUntil && new Date(settings.rateLimitUntil).getTime() <= now.getTime()) {
    patchQueueSettings({ rateLimitUntil: null, lastError: settings.lastError === "rate_limit" ? null : settings.lastError });
  }
  const fresh = getQueueSettings();
  if (fresh.paused) return { action: "paused" };
  if (fresh.rateLimitUntil && new Date(fresh.rateLimitUntil).getTime() > now.getTime()) {
    return { action: "rate_limited", until: fresh.rateLimitUntil };
  }
  if (!tryAcquireLock(now)) return { action: "busy" };
  try {
    deferExtraOverdue(now, options?.random);
    const due = nextDueTweet(now);
    if (!due) return { action: "idle" };

    let client = options?.client;
    if (!client) {
      let credentials;
      try {
        credentials = readCredentials();
      } catch (error) {
        if (error instanceof AppError && (error.code === "decrypt_failed" || error.code === "encryption_key_missing")) {
          pauseQueue(error.code);
          return { action: "no_credentials" };
        }
        throw error;
      }
      if (!credentials) {
        pauseQueue("missing_credentials");
        return { action: "no_credentials" };
      }
      client = createXClient(credentials);
    }

    try {
      const posted = await client.postTweet(due.text);
      patchTweet(due.id, {
        status: "posted",
        postedAt: now.toISOString(),
        tweetId: posted.id,
        errorMessage: null,
      });
      patchQueueSettings({ rateLimitUntil: null, lastError: null });
      return { action: "posted", id: due.id, tweetId: posted.id };
    } catch (error) {
      if (!(error instanceof XApiError)) {
        const message = error instanceof Error ? error.message : "未知错误";
        patchTweet(due.id, { status: "failed", errorMessage: message, attemptCount: due.attemptCount + 1 });
        return { action: "failed", id: due.id };
      }
      if (error.kind === "rate_limit") {
        const until = error.resetAt ?? new Date(now.getTime() + 15 * 60_000);
        patchQueueSettings({ rateLimitUntil: until.toISOString(), lastError: "rate_limit" });
        return { action: "rate_limited", until: until.toISOString() };
      }
      if (error.kind === "auth") {
        pauseQueue(error.message);
        patchTweet(due.id, { errorMessage: error.message });
        return { action: "auth_paused", id: due.id };
      }
      if (error.kind === "transient") {
        const attempts = due.attemptCount + 1;
        if (attempts >= 5) {
          patchTweet(due.id, { status: "failed", errorMessage: error.message, attemptCount: attempts });
          return { action: "failed", id: due.id };
        }
        const backoff = Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1));
        patchTweet(due.id, {
          scheduledAt: new Date(now.getTime() + backoff).toISOString(),
          errorMessage: error.message,
          attemptCount: attempts,
        });
        return { action: "retry_later", id: due.id };
      }
      patchTweet(due.id, {
        status: "failed",
        errorMessage: error.message,
        attemptCount: due.attemptCount + 1,
      });
      return { action: "failed", id: due.id };
    }
  } finally {
    releaseLock();
  }
}
