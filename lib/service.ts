import crypto from "node:crypto";
import { decryptString, encryptString } from "@/lib/crypto";
import {
  deleteCredentials,
  deleteTweet as deleteTweetRow,
  getCredentialsRow,
  getQueueSettings,
  getTweet,
  insertTweets,
  listTweets,
  nextSortOrder,
  patchQueueSettings,
  patchTweet,
  updateAccount,
  upsertCredentials,
} from "@/lib/db";
import { MAX_IMPORT_BATCH, MAX_IMPORT_SOURCE_CHARS } from "@/lib/constants";
import { AppError } from "@/lib/errors";
import { parseImport } from "@/lib/parse-import";
import {
  assertSchedule,
  assertStartAt,
  computeSchedule,
  nextGapMs,
  pushChain,
  randomExtraMs,
  type SchedulePace,
} from "@/lib/schedule";
import type { Credentials, ImportMode, InvalidTweet, PublicState, PublicTweet, Tweet } from "@/lib/types";
import { inspectTweet, MAX_LONG_POST_LENGTH, MAX_WEIGHTED_LENGTH } from "@/lib/weighted-length";
import { createXClient, isMockMode, XApiError } from "@/lib/x-client";

export function readCredentials(): Credentials | null {
  const row = getCredentialsRow();
  if (!row) return null;
  const plain = decryptString(row.ciphertext);
  let parsed: Partial<Credentials>;
  try {
    parsed = JSON.parse(plain) as Partial<Credentials>;
  } catch {
    throw new AppError("decrypt_failed", "已保存的凭据无法读取，请重新填写。", 500);
  }
  if (!parsed.apiKey || !parsed.apiSecret || !parsed.accessToken || !parsed.accessTokenSecret) {
    throw new AppError("decrypt_failed", "已保存的凭据不完整，请重新填写。", 500);
  }
  return {
    apiKey: parsed.apiKey,
    apiSecret: parsed.apiSecret,
    accessToken: parsed.accessToken,
    accessTokenSecret: parsed.accessTokenSecret,
  };
}

function cleanCredential(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function credentialsFromInput(input: Partial<Credentials> | null | undefined): Credentials {
  const credentials = {
    apiKey: cleanCredential(input?.apiKey),
    apiSecret: cleanCredential(input?.apiSecret),
    accessToken: cleanCredential(input?.accessToken),
    accessTokenSecret: cleanCredential(input?.accessTokenSecret),
  };
  if (Object.values(credentials).some((value) => value.length === 0)) {
    throw new AppError("credentials_incomplete", "请填齐 API Key、API Secret、Access Token、Access Token Secret。");
  }
  if (Object.values(credentials).some((value) => value.length > 500)) {
    throw new AppError("credentials_incomplete", "某一项凭据长得不像 X 的密钥。");
  }
  return credentials;
}

export function saveCredentials(input: Partial<Credentials>): { ok: true } {
  const credentials = credentialsFromInput(input);
  upsertCredentials(encryptString(JSON.stringify(credentials)));
  return { ok: true };
}

export function clearCredentials(): { ok: true } {
  deleteCredentials();
  return { ok: true };
}

export async function testCredentials(input?: Partial<Credentials>): Promise<{
  ok: true;
  username: string;
  displayName: string;
  userId: string;
  saved: boolean;
}> {
  const provided = [input?.apiKey, input?.apiSecret, input?.accessToken, input?.accessTokenSecret].map(cleanCredential);
  const usingStored = provided.every((value) => value.length === 0);
  const credentials = usingStored ? readCredentials() : credentialsFromInput(input);
  if (!credentials) {
    throw new AppError("credentials_missing", "还没有保存凭据。");
  }
  try {
    const user = await createXClient(credentials).verify();
    if (usingStored) {
      updateAccount({ username: user.username, displayName: user.name, userId: user.id });
    }
    return {
      ok: true,
      username: user.username,
      displayName: user.name,
      userId: user.id,
      saved: usingStored,
    };
  } catch (error) {
    if (error instanceof XApiError) {
      const prefix = error.kind === "auth" ? "凭据被 X 拒绝。" : "X 接口返回错误。";
      throw new AppError(error.kind === "auth" ? "x_auth" : "x_error", `${prefix}${error.message}`, 400);
    }
    if (error instanceof AppError) throw error;
    throw new AppError("x_network", "连不上 X 的服务器。请检查这台机器的网络。", 502);
  }
}

function toPublicTweet(tweet: Tweet, username: string | null): PublicTweet {
  return {
    ...tweet,
    isLong: tweet.weightedLength > MAX_WEIGHTED_LENGTH,
    tweetUrl: tweet.tweetId
      ? username
        ? `https://x.com/${username}/status/${tweet.tweetId}`
        : `https://x.com/i/web/status/${tweet.tweetId}`
      : null,
  };
}

export function getPublicState(): PublicState {
  const row = getCredentialsRow();
  const tweets = listTweets();
  const counts = { pending: 0, posted: 0, failed: 0 };
  for (const tweet of tweets) counts[tweet.status] += 1;
  return {
    mockMode: isMockMode(),
    credentialsConfigured: Boolean(row),
    account:
      row?.username && row.user_id
        ? {
            username: row.username,
            displayName: row.display_name || row.username,
            userId: row.user_id,
          }
        : null,
    queue: getQueueSettings(),
    counts,
    tweets: tweets.map((tweet) => toPublicTweet(tweet, row?.username ?? null)),
  };
}

export function importTweets(input: {
  source: string;
  format: "text" | "csv";
  startAt: string;
  intervalMinutes: number;
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  random?: () => number;
}): {
  ok: true;
  mode: ImportMode;
  queuedCount: number;
  queued: PublicTweet[];
  invalid: InvalidTweet[];
  longCount: number;
  omittedCount: number;
  batchLimit: number;
} {
  if (typeof input.source !== "string") {
    throw new AppError("invalid_text", "没有收到要导入的文本。");
  }
  if (input.source.length > MAX_IMPORT_SOURCE_CHARS) {
    throw new AppError("too_many", "文本太长，请分成几批导入。");
  }
  const format = input.format === "csv" ? "csv" : "text";
  const saved = getQueueSettings();
  const randomMinSeconds = input.randomMinSeconds ?? saved.randomMinSeconds;
  const randomMaxSeconds = input.randomMaxSeconds ?? saved.randomMaxSeconds;
  assertSchedule(input.intervalMinutes, randomMinSeconds, randomMaxSeconds);
  const start = assertStartAt(input.startAt);
  const parsed = parseImport(input.source, format);
  const valid: Array<{ text: string; weightedLength: number }> = [];
  const invalid: InvalidTweet[] = [];
  parsed.tweets.forEach((text, index) => {
    const inspected = inspectTweet(text);
    if (!inspected.valid) {
      invalid.push({
        index,
        text: inspected.text || text.trim(),
        weightedLength: inspected.weightedLength,
        reason: inspected.reason || "empty",
      });
      return;
    }
    valid.push({ text: inspected.text, weightedLength: inspected.weightedLength });
  });
  const omittedCount = Math.max(0, valid.length - MAX_IMPORT_BATCH);
  const accepted = valid.slice(0, MAX_IMPORT_BATCH);
  const times = computeSchedule({
    count: accepted.length,
    startAt: start,
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
    random: input.random,
  });
  const now = new Date().toISOString();
  let order = nextSortOrder();
  const rows: Tweet[] = accepted.map((item, index) => ({
    id: crypto.randomUUID(),
    text: item.text,
    weightedLength: item.weightedLength,
    status: "pending",
    scheduledAt: times[index].toISOString(),
    postedAt: null,
    tweetId: null,
    errorMessage: null,
    attemptCount: 0,
    sortOrder: order++,
    delayReason: null,
    createdAt: now,
    updatedAt: now,
  }));
  insertTweets(rows);
  patchQueueSettings({
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
  });
  const username = getCredentialsRow()?.username ?? null;
  return {
    ok: true,
    mode: parsed.mode,
    queuedCount: rows.length,
    queued: rows.map((row) => toPublicTweet(row, username)),
    invalid,
    longCount: rows.filter((row) => row.weightedLength > MAX_WEIGHTED_LENGTH).length,
    omittedCount,
    batchLimit: MAX_IMPORT_BATCH,
  };
}

export function updateTweetText(id: string, text: unknown): PublicTweet {
  if (typeof text !== "string") throw new AppError("invalid_text", "帖子内容不能为空。");
  const existing = getTweet(id);
  if (!existing) throw new AppError("not_found", "这条帖子不在队列里。", 404);
  if (existing.status === "posted") {
    throw new AppError("invalid_status", "已经发出的帖子不能再改。");
  }
  const inspected = inspectTweet(text);
  if (!inspected.valid) {
    throw new AppError(
      inspected.reason === "too_long" ? "too_long" : "invalid_text",
      inspected.reason === "too_long" ? `超过 ${MAX_LONG_POST_LENGTH} 字上限（现为 ${inspected.weightedLength}）。` : "帖子内容不能为空。",
    );
  }
  patchTweet(id, { text: inspected.text, weightedLength: inspected.weightedLength, errorMessage: null });
  const updated = getTweet(id);
  if (!updated) throw new AppError("not_found", "这条帖子不在队列里。", 404);
  return toPublicTweet(updated, getCredentialsRow()?.username ?? null);
}

export function removeTweet(id: string): { ok: true } {
  if (!deleteTweetRow(id)) throw new AppError("not_found", "这条帖子不在队列里。", 404);
  return { ok: true };
}

export function retryTweet(id: string, now = new Date()): PublicTweet {
  const existing = getTweet(id);
  if (!existing) throw new AppError("not_found", "这条帖子不在队列里。", 404);
  if (existing.status !== "failed") {
    throw new AppError("invalid_status", "只有失败的帖子需要重试。");
  }
  patchTweet(id, {
    status: "pending",
    scheduledAt: now.toISOString(),
    errorMessage: null,
    attemptCount: 0,
  });
  const updated = getTweet(id);
  if (!updated) throw new AppError("not_found", "这条帖子不在队列里。", 404);
  return toPublicTweet(updated, getCredentialsRow()?.username ?? null);
}

export function retryAllFailed(now = new Date(), random = Math.random): { ok: true; count: number } {
  const failed = listTweets().filter((tweet) => tweet.status === "failed");
  if (failed.length === 0) return { ok: true, count: 0 };
  const settings = getQueueSettings();
  const times = computeSchedule({
    count: failed.length,
    startAt: now,
    intervalMinutes: settings.intervalMinutes,
    randomMinSeconds: settings.randomMinSeconds,
    randomMaxSeconds: settings.randomMaxSeconds,
    random,
  });
  failed.forEach((tweet, index) => {
    patchTweet(tweet.id, {
      status: "pending",
      scheduledAt: times[index].toISOString(),
      errorMessage: null,
      attemptCount: 0,
    });
  });
  return { ok: true, count: failed.length };
}

export function pendingInOrder(): Tweet[] {
  return listTweets()
    .filter((tweet) => tweet.status === "pending")
    .sort(compareTweets);
}

export function reorderTweet(id: string, direction: "up" | "down"): { ok: true; moved: boolean } {
  if (direction !== "up" && direction !== "down") {
    throw new AppError("invalid_status", "只能上移或下移。");
  }
  const pending = pendingInOrder();
  const index = pending.findIndex((tweet) => tweet.id === id);
  if (index < 0) throw new AppError("invalid_status", "只能调整还没发出的帖子。");
  const neighbor = direction === "up" ? index - 1 : index + 1;
  if (neighbor < 0 || neighbor >= pending.length) return { ok: true, moved: false };
  const current = pending[index];
  const other = pending[neighbor];
  patchTweet(current.id, { scheduledAt: other.scheduledAt, sortOrder: other.sortOrder });
  patchTweet(other.id, { scheduledAt: current.scheduledAt, sortOrder: current.sortOrder });
  return { ok: true, moved: true };
}

export function pauseQueue(reason = "manual"): { ok: true } {
  patchQueueSettings({ paused: true, pauseReason: reason });
  return { ok: true };
}

export function resumeQueue(): { ok: true } {
  patchQueueSettings({ paused: false, pauseReason: null });
  return { ok: true };
}

export function updateScheduleSettings(input: {
  intervalMinutes: number;
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  reschedule?: boolean;
  startAt?: string;
  random?: () => number;
}): { ok: true } {
  const current = getQueueSettings();
  const randomMinSeconds = input.randomMinSeconds ?? current.randomMinSeconds;
  const randomMaxSeconds = input.randomMaxSeconds ?? current.randomMaxSeconds;
  assertSchedule(input.intervalMinutes, randomMinSeconds, randomMaxSeconds);
  patchQueueSettings({
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
  });
  if (input.reschedule) {
    const pending = pendingInOrder();
    const start = input.startAt ? assertStartAt(input.startAt) : new Date();
    const times = computeSchedule({
      count: pending.length,
      startAt: start,
      intervalMinutes: input.intervalMinutes,
      randomMinSeconds,
      randomMaxSeconds,
      random: input.random,
    });
    pending.forEach((tweet, index) => {
      patchTweet(tweet.id, { scheduledAt: times[index].toISOString(), delayReason: null });
    });
  }
  return { ok: true };
}

function currentPace(): SchedulePace {
  const settings = getQueueSettings();
  return {
    intervalMinutes: settings.intervalMinutes,
    randomMinSeconds: settings.randomMinSeconds,
    randomMaxSeconds: settings.randomMaxSeconds,
  };
}

/** Move a chain of pending posts later (never earlier); returns true when anything moved. */
function applyChain(
  tweets: Tweet[],
  firstMinAt: Date,
  random: () => number,
  extra?: Partial<Pick<Tweet, "delayReason">>,
): boolean {
  if (tweets.length === 0) return false;
  const originals = tweets.map((tweet) => new Date(tweet.scheduledAt));
  const times = pushChain({ originals, firstMinAt, pace: currentPace(), random });
  let moved = false;
  tweets.forEach((tweet, index) => {
    if (times[index].getTime() === originals[index].getTime()) return;
    moved = true;
    patchTweet(tweet.id, { scheduledAt: times[index].toISOString(), ...(extra ?? {}) });
  });
  return moved;
}

/**
 * A post exists at `lastPostAt` (on X or sent by us). If the next pending post
 * would land within one interval of it, move it to lastPostAt + interval +
 * random extra, and push the rest so each gap stays interval + random extra.
 * Returns the new time of the first pending post, or null when nothing moved.
 */
export function delayPendingForRecentPost(lastPostAt: Date, manual: boolean, random: () => number = Math.random): Date | null {
  const pending = pendingInOrder();
  if (pending.length === 0) return null;
  const pace = currentPace();
  const firstAt = new Date(pending[0].scheduledAt).getTime();
  if (Number.isNaN(firstAt) || firstAt >= lastPostAt.getTime() + pace.intervalMinutes * 60_000) return null;
  const target = new Date(lastPostAt.getTime() + nextGapMs(pace, random));
  applyChain(pending, target, random, manual ? { delayReason: "manual" } : undefined);
  return new Date(pendingInOrder()[0].scheduledAt);
}

/**
 * A new manual post appeared at `manualAt`: re-anchor the whole pending queue so the
 * next post is manualAt + interval + one random extra (rolled once, stored as the
 * scheduledAt), and every later post follows with interval + random extra gaps.
 */
export function reanchorPendingToManual(manualAt: Date, random: () => number = Math.random): Date | null {
  const pending = pendingInOrder();
  if (pending.length === 0) return null;
  const pace = currentPace();
  const times = computeSchedule({
    count: pending.length,
    startAt: new Date(Math.ceil((manualAt.getTime() + nextGapMs(pace, random)) / 1000) * 1000),
    ...pace,
    random,
  });
  pending.forEach((tweet, index) => {
    patchTweet(tweet.id, { scheduledAt: times[index].toISOString(), delayReason: "manual" });
  });
  return times[0];
}

/** After an X rate limit, resume at `until` plus a random extra delay, keeping randomized gaps. */
export function delayPendingForRateLimit(until: Date, random: () => number = Math.random): void {
  const pending = pendingInOrder();
  applyChain(pending, new Date(until.getTime() + randomExtraMs(currentPace(), random)), random);
}

export function latestLocalPost(): { id: string; at: Date } | null {
  const posted = listTweets().filter((tweet) => tweet.status === "posted" && tweet.postedAt);
  if (posted.length === 0) return null;
  posted.sort((left, right) => right.postedAt!.localeCompare(left.postedAt!));
  const newest = posted[0];
  const at = new Date(newest.postedAt!);
  if (Number.isNaN(at.getTime())) return null;
  return { id: newest.tweetId ?? "", at };
}

export function deferExtraOverdue(now: Date, random = Math.random): void {
  const pending = pendingInOrder();
  const overdue = pending.filter((tweet) => new Date(tweet.scheduledAt).getTime() <= now.getTime());
  if (overdue.length <= 1) return;
  // The first overdue post goes out now; the rest follow at interval + random extra each.
  applyChain(pending.slice(1), new Date(now.getTime() + nextGapMs(currentPace(), random)), random);
}

export function nextDueTweet(now: Date): Tweet | null {
  return (
    listTweets()
      .filter((tweet) => tweet.status === "pending" && new Date(tweet.scheduledAt).getTime() <= now.getTime())
      .sort(compareTweets)[0] ?? null
  );
}

function compareTweets(a: Tweet, b: Tweet): number {
  const time = a.scheduledAt.localeCompare(b.scheduledAt);
  if (time !== 0) return time;
  return a.sortOrder - b.sortOrder;
}
