import { TIMELINE_CACHE_TTL_MS } from "@/lib/constants";
import {
  getAnchoredManualId,
  getCredentialsRow,
  getQueueSettings,
  getTimelineCache,
  listTweets,
  patchQueueSettings,
  patchTweet,
  releaseLock,
  setAnchoredManualId,
  setTimelineCache,
  tryAcquireLock,
  updateAccount,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  delayPendingForRateLimit,
  delayPendingForRecentPost,
  deferExtraOverdue,
  latestLocalPost,
  nextDueTweet,
  pauseQueue,
  pendingInOrder,
  readCredentials,
  reanchorPendingToManual,
} from "@/lib/service";
import { shouldReuseTimelineCache } from "@/lib/timeline";
import type { Tweet, TweetExtra } from "@/lib/types";
import type { XClient, XTimelineTweet } from "@/lib/x-client";
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
  | { action: "retry_later"; id: string }
  | { action: "deferred"; until: string; manual: boolean };

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
    // Read X only when a post is actually due (one fresh timeline read per post),
    // not while waiting for it: this keeps billable X reads to ~1 per post.
    if (!nextDueTweet(now)) return { action: "idle" };

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

    // Right before posting, always read X fresh so a manual post from seconds ago is seen.
    const gap = await recentPostGap(now, client, fresh.intervalMinutes * 60_000, true);
    // A new manual post on X re-anchors the queue once (random extra rolled once and stored).
    if (gap?.manual && gap.id && gap.id !== getAnchoredManualId()) {
      setAnchoredManualId(gap.id);
      const until = reanchorPendingToManual(gap.at, options?.random);
      if (until) return { action: "deferred", until: until.toISOString(), manual: true };
    }
    const due = nextDueTweet(now);
    if (!due) return { action: "idle" };
    if (gap && now.getTime() < gap.at.getTime() + fresh.intervalMinutes * 60_000) {
      // Hard rule: never closer than one interval. The new slot is interval + random extra.
      const moved = delayPendingForRecentPost(gap.at, gap.manual, options?.random);
      const until = moved ?? new Date(gap.at.getTime() + fresh.intervalMinutes * 60_000);
      return { action: "deferred", until: until.toISOString(), manual: gap.manual };
    }

    try {
      const posted = await postUnit(client, due);
      patchTweet(due.id, {
        status: "posted",
        postedAt: now.toISOString(),
        tweetId: posted.id,
        errorMessage: null,
        delayReason: null,
      });
      patchQueueSettings({ rateLimitUntil: null, lastError: null });
      setTimelineCache({
        checkedAt: now.toISOString(),
        latestAt: now.toISOString(),
        latestId: posted.id,
        ok: true,
      });
      return { action: "posted", id: due.id, tweetId: posted.id };
    } catch (error) {
      if (!(error instanceof XApiError)) {
        const message = error instanceof Error ? error.message : "未知错误";
        patchTweet(due.id, { status: "failed", errorMessage: message, attemptCount: due.attemptCount + 1 });
        return { action: "failed", id: due.id };
      }
      if (error.kind === "rate_limit" || error.kind === "credits") {
        // 402 (API credits used up): pause ~10 min instead of marking the post failed.
        const until =
          error.kind === "credits"
            ? new Date(now.getTime() + 10 * 60_000)
            : (error.resetAt ?? new Date(now.getTime() + 15 * 60_000));
        patchQueueSettings({ rateLimitUntil: until.toISOString(), lastError: "rate_limit" });
        delayPendingForRateLimit(until, options?.random);
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

async function uploadAll(client: XClient, paths: string[] | undefined): Promise<string[] | undefined> {
  if (!paths?.length) return undefined;
  if (!client.uploadMedia) throw new XApiError("当前客户端不支持上传图片。", "rejected", 0);
  const ids: string[] = [];
  for (const file of paths) ids.push(await client.uploadMedia(file));
  return ids;
}

/**
 * Post one queue item: the head (with its images), then every thread reply right
 * away, each replying to the previous one. Progress is saved after each post so a
 * retry resumes where it stopped instead of posting duplicates.
 */
async function postUnit(client: XClient, due: Tweet): Promise<{ id: string }> {
  const extra: TweetExtra = due.extra ? JSON.parse(JSON.stringify(due.extra)) : {};
  if (!extra.media?.length && !extra.thread?.length) return client.postTweet(due.text);
  let headId = extra.headTweetId ?? null;
  if (!headId) {
    const mediaIds = await uploadAll(client, extra.media);
    headId = (await client.postTweet(due.text, { mediaIds })).id;
    extra.headTweetId = headId;
    patchTweet(due.id, { tweetId: headId, extra });
  }
  let previous = headId;
  for (const reply of extra.thread ?? []) {
    if (reply.tweetId) {
      previous = reply.tweetId;
      continue;
    }
    const mediaIds = await uploadAll(client, reply.media);
    const posted = await client.postTweet(reply.text, { mediaIds, replyTo: previous });
    reply.tweetId = posted.id;
    previous = posted.id;
    patchTweet(due.id, { extra });
  }
  return { id: headId };
}

const DUE_CACHE_TTL_MS = 10_000;

const TIMELINE_LOG = "[序帖] 读取最近帖子失败，改用本工具自己的上次发送时间。";

async function recentPostGap(
  now: Date,
  client: XClient,
  intervalMs: number,
  forceFresh = false,
): Promise<{ at: Date; manual: boolean; id: string } | null> {
  if (!client.latestTweet) return null;
  const remote = await readRemoteLatest(now, client, intervalMs, forceFresh);
  const local = latestLocalPost();
  const winner = laterPost(remote, local);
  if (!winner) return null;
  const ours = new Set(listTweets().map((tweet) => tweet.tweetId).filter((id): id is string => Boolean(id)));
  return { at: winner.at, manual: Boolean(winner.id) && !ours.has(winner.id), id: winner.id };
}

function laterPost(
  remote: { id: string; at: Date } | null,
  local: { id: string; at: Date } | null,
): { id: string; at: Date } | null {
  if (!remote) return local;
  if (!local) return remote;
  return remote.at.getTime() >= local.at.getTime() ? remote : local;
}

async function readRemoteLatest(
  now: Date,
  client: XClient,
  intervalMs: number,
  forceFresh: boolean,
): Promise<{ id: string; at: Date } | null> {
  if (!client.latestTweet) return null;
  const cache = getTimelineCache();
  const reusable = shouldReuseTimelineCache({
    checkedAt: cache.checkedAt,
    latestAt: cache.latestAt,
    ok: cache.ok,
    now,
    intervalMs,
    // When a post is due, only trust a read from the last few seconds.
    ttlMs: forceFresh ? DUE_CACHE_TTL_MS : TIMELINE_CACHE_TTL_MS,
  });
  if (reusable) {
    if (!cache.ok) return null;
    return cacheToPost(cache.latestId, cache.latestAt);
  }

  let userId = getCredentialsRow()?.user_id ?? null;
  if (!userId) {
    try {
      const user = await client.verify();
      userId = user.id;
      if (getCredentialsRow()) {
        updateAccount({ username: user.username, displayName: user.name, userId: user.id });
      }
    } catch (error) {
      console.warn(TIMELINE_LOG, error instanceof Error ? error.message : error);
      rememberTimelineError(now);
      return null;
    }
  }

  try {
    const latest = await client.latestTweet(userId);
    const parsed = normalizeTimelineTweet(latest);
    setTimelineCache({
      checkedAt: now.toISOString(),
      latestAt: parsed?.at.toISOString() ?? null,
      latestId: parsed?.id ?? null,
      ok: true,
    });
    return parsed;
  } catch (error) {
    console.warn(TIMELINE_LOG, error instanceof Error ? error.message : error);
    rememberTimelineError(now);
    return null;
  }
}

function rememberTimelineError(now: Date): void {
  const previous = getTimelineCache();
  setTimelineCache({
    checkedAt: now.toISOString(),
    latestAt: previous.latestAt,
    latestId: previous.latestId,
    ok: false,
  });
}

function cacheToPost(id: string | null, at: string | null): { id: string; at: Date } | null {
  if (!at) return null;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return { id: id ?? "", at: parsed };
}

function normalizeTimelineTweet(tweet: XTimelineTweet | null): { id: string; at: Date } | null {
  if (!tweet?.id || !tweet.createdAt) return null;
  const at = new Date(tweet.createdAt);
  if (Number.isNaN(at.getTime())) return null;
  return { id: tweet.id, at };
}
