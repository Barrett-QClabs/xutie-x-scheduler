/**
 * Daily stats by X day (UTC calendar day = 08:00–08:00 Asia/Taipei / Shanghai).
 * Local sources: automation logs (follows / unfollows), follower cache (follow-backs), 序帖 DB (posts).
 * X API source: the user's own timeline (replies + impression_count), cached per day
 * (today refreshed at most every 60 min; a past day is read once after it has ended and then
 * cached permanently, to keep billable X reads low). On fetch failure the value is
 * null ("unavailable") unless an earlier successful fetch exists, which is returned with its time.
 */
import fs from "node:fs";
import path from "node:path";
import { AUTOMATION_DIR } from "@/lib/automation";
import { getCredentialsRow, getDb } from "@/lib/db";
import { readCredentials } from "@/lib/service";
import { isMockMode, xGet } from "@/lib/x-client";

const TODAY_TTL_MS = 60 * 60_000;
/** Manual refresh ("刷新") re-reads today at most this often. */
const FORCE_MIN_AGE_MS = 10 * 60_000;
const CACHE_FILE = path.join(process.cwd(), "data", "stats-cache.json");

type TimelineDay = { fetchedAt: string; complete: boolean; posts: number; replies: number; impressions: number; withMetrics: number; error?: string };
type Cache = { userId?: string; days: Record<string, TimelineDay>; lastError?: { at: string; message: string } };

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const shift = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

function readJsonl(file: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((e): e is Record<string, unknown> => !!e);
  } catch { return []; }
}
function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache; } catch { return { days: {} }; }
}
function saveCache(c: Cache) {
  try { fs.writeFileSync(`${CACHE_FILE}.tmp`, JSON.stringify(c, null, 2)); fs.renameSync(`${CACHE_FILE}.tmp`, CACHE_FILE); } catch {}
}

async function fetchTimelineDay(userId: string, day: string): Promise<TimelineDay> {
  const credentials = readCredentials();
  if (!credentials) throw new Error("no credentials");
  const start = `${day}T00:00:00Z`;
  const endMs = Math.min(Date.parse(`${shift(day, 1)}T00:00:00Z`), Date.now() - 15_000);
  const out: TimelineDay = { fetchedAt: new Date().toISOString(), complete: false, posts: 0, replies: 0, impressions: 0, withMetrics: 0 };
  let token: string | undefined;
  for (let page = 0; page < 30; page += 1) {
    const q: Record<string, string> = { max_results: "100", start_time: start, end_time: new Date(endMs).toISOString(),
      exclude: "retweets", "tweet.fields": "created_at,public_metrics,referenced_tweets" };
    if (token) q.pagination_token = token;
    const payload = await xGet(credentials, `/2/users/${encodeURIComponent(userId)}/tweets`, q);
    for (const t of (Array.isArray(payload.data) ? payload.data : []) as Record<string, unknown>[]) {
      const refs = Array.isArray(t.referenced_tweets) ? (t.referenced_tweets as { type?: string }[]) : [];
      if (refs.some((r) => r.type === "replied_to")) out.replies += 1; else out.posts += 1;
      const imp = (t.public_metrics as { impression_count?: number } | undefined)?.impression_count;
      if (typeof imp === "number") { out.impressions += imp; out.withMetrics += 1; }
    }
    token = (payload.meta as { next_token?: string } | undefined)?.next_token;
    if (!token) { out.complete = true; break; }
  }
  return out;
}

let inflight: Promise<void> | null = null;
async function refreshTimeline(days: string[], force: boolean): Promise<Cache> {
  const cache = loadCache();
  const userId = getCredentialsRow()?.user_id ?? undefined;
  if (!userId || isMockMode()) return cache;
  if (cache.userId && cache.userId !== userId) cache.days = {};
  cache.userId = userId;
  const today = utcDay(new Date());
  const stale = days.filter((d) => {
    const c = cache.days[d];
    if (!c) return true;
    const age = Date.now() - Date.parse(c.fetchedAt);
    if (d === today) return age > (force ? FORCE_MIN_AGE_MS : TODAY_TTL_MS);
    // A past day is final once it was read completely after it ended: never re-read it
    // (even on manual refresh). One fetched while still "today" is re-read once.
    const fetchedBeforeEnd = Date.parse(c.fetchedAt) < Date.parse(`${shift(d, 1)}T00:00:00Z`);
    return fetchedBeforeEnd || !c.complete;
  });
  if (!stale.length) return cache;
  if (!inflight) {
    inflight = (async () => {
      for (const d of stale) {
        try { cache.days[d] = await fetchTimelineDay(userId, d); }
        catch (error) {
          cache.lastError = { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
          break; // stop on first error (likely rate limit); keep earlier values
        }
      }
      saveCache(cache);
    })().finally(() => { inflight = null; });
  }
  await inflight;
  return loadCache();
}

export async function getDailyStats(opts: { days?: number; refresh?: boolean } = {}) {
  const n = Math.min(Math.max(Math.floor(opts.days ?? 7), 1), 14);
  const today = utcDay(new Date());
  const days = Array.from({ length: n }, (_, i) => shift(today, -i));
  const dayOf = (e: Record<string, unknown>) => (typeof e.time === "string" ? utcDay(new Date(e.time)) : "");

  const fb = readJsonl(path.join(AUTOMATION_DIR, "followback.jsonl")).filter((e) => e.result === "ok");
  const kw = readJsonl(path.join(AUTOMATION_DIR, "keywordfollow.jsonl")).filter((e) => e.result === "ok");
  const unf = readJsonl(path.join(AUTOMATION_DIR, "log.jsonl")).filter((e) => e.result === "ok");
  let followers: Set<string> | null = null, followersAsOf: string | null = null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(AUTOMATION_DIR, "cache.json"), "utf8")) as { timestamp: string; followers: { id: string }[] };
    followers = new Set(c.followers.map((u) => u.id)); followersAsOf = c.timestamp;
  } catch {}

  let postedByDay: Record<string, number> | null = null;
  try {
    const rows = getDb().prepare("SELECT posted_at FROM tweets WHERE status = 'posted' AND posted_at >= ?").all(`${days[days.length - 1]}T00:00:00`) as { posted_at: string }[];
    postedByDay = {};
    for (const r of rows) { const d = utcDay(new Date(r.posted_at)); postedByDay[d] = (postedByDay[d] ?? 0) + 1; }
  } catch {}

  let cache: Cache = loadCache();
  let timelineError: string | null = null;
  try { cache = await refreshTimeline(days, !!opts.refresh); } catch (error) { timelineError = error instanceof Error ? error.message : String(error); }
  if (cache.lastError && Date.now() - Date.parse(cache.lastError.at) < 30 * 60_000) timelineError = cache.lastError.message;

  const rows = days.map((d) => {
    const fbN = fb.filter((e) => dayOf(e) === d).length;
    const kwIds = kw.filter((e) => dayOf(e) === d).map((e) => String(e.id));
    const followedBack = followers ? kwIds.filter((id) => followers!.has(id)).length : null;
    const posted = postedByDay ? postedByDay[d] ?? 0 : null;
    // GET /2/users/:id/tweets only reaches the ~3200 most recent tweets; a day that shows fewer
    // own posts than 序帖 published is past that horizon, so its numbers would be undercounts.
    const raw = cache.days[d];
    const beyondHorizon = !!raw && posted !== null && raw.posts < posted;
    const t = beyondHorizon ? undefined : raw;
    return {
      day: d,
      window: { from: `${d}T00:00:00Z`, to: `${shift(d, 1)}T00:00:00Z`, local: `${d} 08:00 – ${shift(d, 1)} 08:00 (UTC+8)` },
      isToday: d === today,
      follows: { total: fbN + kwIds.length, followBack: fbN, keyword: kwIds.length },
      keywordFollowedBack: followedBack,
      followBackRatio: followedBack === null ? null : kwIds.length ? Math.round((followedBack / kwIds.length) * 1000) / 10 : null,
      unfollows: unf.filter((e) => dayOf(e) === d).length,
      postsBy序帖: posted,
      replies: t ? t.replies : null,
      ownPostsOnX: t ? t.posts : null,
      impressions: t ? t.impressions : null,
      timelineNote: beyondHorizon ? "beyond X timeline 3200-tweet limit (unavailable)" : null,
      timeline: t ? { fetchedAt: t.fetchedAt, complete: t.complete, tweetsWithMetrics: t.withMetrics } : null,
    };
  });
  return {
    ok: true,
    dayDefinition: "X day = UTC calendar day = 08:00–08:00 Asia/Taipei",
    generatedAt: new Date().toISOString(),
    sources: {
      follows: "followback.jsonl + keywordfollow.jsonl (result ok)",
      keywordFollowedBack: `keyword-followed accounts present in follower list (cache.json as of ${followersAsOf ?? "unavailable"})`,
      unfollows: "log.jsonl (result ok)",
      postsBy序帖: "序帖 DB tweets.status = posted by posted_at",
      repliesAndImpressions: "GET /2/users/:id/tweets (exclude=retweets), public_metrics.impression_count; cached 60 min (today) / permanently once a past day has ended",
    },
    timelineError,
    days: rows,
  };
}
