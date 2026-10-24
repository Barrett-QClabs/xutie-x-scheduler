#!/usr/bin/env node
/**
 * Keyword auto-follow daemon for @barrett_tt.
 *  1. Once per Asia/Shanghai day builds keyword-candidates/YYYY-MM-DD.json (default 250 accounts):
 *     authors of recent posts about the configured keywords (X API v2 recent search, user's OAuth1 keys),
 *     blue-V (any verification), followers < 1000, not protected, not already followed, not @me,
 *     never followed/unfollowed before by these scripts (log.jsonl, followback.jsonl, keywordfollow.jsonl).
 *  2. Follows from that pool, sharing the combined daily cap (350) with followback.mjs.
 *     Follow-back has priority: we only follow while follow-back is resting/idle/capped/off, and keep
 *     room for its remaining targets. ~10 follows per ~15 min (75-105 s gaps), then ~15 min rest (±3 min).
 *     Shared 15-min window (45/50) + cross-process mutex with followback.mjs.
 *
 *   node keywordfollow.mjs              # daemon (start-keywordfollow.sh)
 *   node keywordfollow.mjs --build-only # just build today's pool and exit
 *   node keywordfollow.mjs --dry-run    # show what would happen, no follows
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadCredentials, xRequest, extractErrorMessage, isBlueV, dayKey, sleep, loadCache, loadAlreadyUnfollowedIds,
} from "./unfollow.mjs";
import {
  DATA_DIR, KW_LOG, KW_STATUS, FB_LOG, FB_STATUS, loadConfig, readJsonl, readJson, followCountsToday,
  withFollowMutex, waitForWindow, stopFlagToday, setStopFlag, msUntilNextShanghaiMidnight,
} from "./follow-common.mjs";

const LOCK = path.join(DATA_DIR, "keywordfollow.lock");
const POOL_DIR = path.join(DATA_DIR, "keyword-candidates");
const CYCLE_SIZE = 10;
const GAP_MS = () => 75_000 + Math.floor(Math.random() * 30_001);
const REST_MS = () => 12 * 60_000 + Math.floor(Math.random() * 6 * 60_000);
const FB_CYCLE_MS = 30 * 60_000; // follow-back: 10 follows per ~30 min (15 min cycle + 15 min rest)
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const buildOnly = args.includes("--build-only");

const ts = () => new Date().toISOString();
const say = (m) => console.log(`[${ts()}] ${m}`);
const logKw = (e) => fs.appendFileSync(KW_LOG, JSON.stringify(e) + "\n");
let statusBase = {};
const writeStatus = (o) => { statusBase = { ...statusBase, ...o }; try { fs.writeFileSync(KW_STATUS, JSON.stringify({ updated: ts(), pid: process.pid, ...o, counts: followCountsToday(), pool: statusBase.pool }, null, 2)); } catch {} };

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, "utf8").trim());
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); return false; } } catch {}
  }
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => { try { if (fs.readFileSync(LOCK, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { say(`got ${sig}, exiting`); release(); process.exit(0); });
  return true;
}

/** ids we must never (re)follow: currently followed, unfollowed by us, already followed by any script */
function excludedIds(userId) {
  const s = new Set([userId]);
  for (const u of loadCache()?.following ?? []) s.add(u.id);
  for (const id of loadAlreadyUnfollowedIds()) s.add(id);
  for (const e of readJsonl(FB_LOG)) if (e.id && (e.result === "ok" || e.pending)) s.add(e.id);
  for (const e of readJsonl(KW_LOG)) if (e.id && e.result === "ok") s.add(e.id);
  return s;
}

const poolPath = (day) => path.join(POOL_DIR, `${day}.json`);

async function buildPool(credentials, userId, username) {
  const cfg = loadConfig().keywordfollow;
  const day = dayKey(new Date());
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const exclude = excludedIds(userId);
  // also skip anyone already offered in an earlier day's pool (keeps pools fresh)
  for (const f of fs.readdirSync(POOL_DIR).filter((f) => f < `${day}.json` && f.endsWith(".json"))) {
    for (const c of readJson(path.join(POOL_DIR, f))?.candidates ?? []) exclude.add(c.id);
  }
  const candidates = new Map();
  const perKeyword = Object.fromEntries(cfg.keywords.map((k) => [k, { pages: 0, posts: 0, added: 0, done: false }]));
  const tokens = {};
  let pages = 0, postsRead = 0, error = null, rejected = { notVerified: 0, tooManyFollowers: 0, protected: 0, excluded: 0 };
  while (candidates.size < cfg.poolSize && pages < cfg.maxSearchPages) {
    const active = cfg.keywords.filter((k) => !perKeyword[k].done);
    if (!active.length) break;
    for (const kw of active) {
      if (candidates.size >= cfg.poolSize || pages >= cfg.maxSearchPages) break;
      const q = { query: `${/\s/.test(kw) ? `"${kw}"` : kw} is:verified -is:retweet`, max_results: "100",
        expansions: "author_id", "user.fields": "verified,verified_type,public_metrics,protected,username,name",
        "tweet.fields": "created_at" };
      if (tokens[kw]) q.next_token = tokens[kw];
      const r = await xRequest(credentials, "GET", "/2/tweets/search/recent", q);
      pages += 1; perKeyword[kw].pages += 1;
      if (r.status === 429) { const w = Math.max(30_000, Number(r.rate.reset) * 1000 - Date.now() + 5_000); say(`search 429; waiting ${Math.round(w / 1000)}s`); await sleep(w); continue; }
      if (!r.ok) { error = { status: r.status, detail: extractErrorMessage(r.body) }; say(`search failed HTTP ${r.status}: ${error.detail}`); break; }
      const tweets = r.body?.data ?? []; postsRead += tweets.length; perKeyword[kw].posts += tweets.length;
      const users = new Map((r.body?.includes?.users ?? []).map((u) => [u.id, u]));
      for (const t of tweets) {
        const u = users.get(t.author_id);
        if (!u || candidates.has(u.id)) continue;
        if (!isBlueV(u)) { rejected.notVerified++; continue; }
        if ((u.public_metrics?.followers_count ?? Infinity) >= cfg.maxFollowers) { rejected.tooManyFollowers++; continue; }
        if (u.protected) { rejected.protected++; continue; }
        if (exclude.has(u.id) || u.username?.toLowerCase() === username.toLowerCase()) { rejected.excluded++; continue; }
        candidates.set(u.id, { id: u.id, username: u.username, name: u.name, followers_count: u.public_metrics.followers_count,
          verified: u.verified === true, verified_type: u.verified_type ?? null, keyword: kw, tweet_id: t.id, tweet_at: t.created_at,
          text: (t.text ?? "").replace(/\s+/g, " ").slice(0, 140) });
        perKeyword[kw].added += 1;
        if (candidates.size >= cfg.poolSize) break;
      }
      tokens[kw] = r.body?.meta?.next_token;
      if (!tokens[kw]) perKeyword[kw].done = true;
    }
    if (error) break;
  }
  const pool = { date: day, built: ts(), source: "x-api-v2-recent-search (user OAuth1)", keywords: cfg.keywords,
    target: cfg.poolSize, count: candidates.size, searchPages: pages, postsRead, perKeyword, rejected, error,
    filters: { verified: "verified==true or verified_type!=none", maxFollowers: cfg.maxFollowers, protected: false,
      notFollowing: true, notPreviouslyFollowedOrUnfollowed: true },
    candidates: [...candidates.values()] };
  if (candidates.size > 0 || !error) fs.writeFileSync(poolPath(day), JSON.stringify(pool, null, 2));
  say(`pool ${day}: ${pool.count}/${cfg.poolSize} candidates from ${pages} search pages (${postsRead} posts)${error ? `; error HTTP ${error.status}` : ""}`);
  return pool;
}

function loadPool(day) { return readJson(poolPath(day)); }

/** Follow-back has priority: may keyword-follow now? */
function followbackAllowsUs() {
  const fb = readJson(FB_STATUS);
  if (!fb) return { ok: true, why: "no follow-back status" };
  let alive = false; try { process.kill(fb.pid, 0); alive = true; } catch {}
  if (!alive) return { ok: true, why: "follow-back not running" };
  if (["idle", "daily_cap", "disabled", "stopped_for_day", "fatal", "stopped_auth"].includes(fb.state)) return { ok: true, why: `follow-back ${fb.state}` };
  if (fb.state === "resting" && fb.resumeAt && Date.parse(fb.resumeAt) - Date.now() > 2 * 60_000) return { ok: true, why: "follow-back resting" };
  const resume = fb.state === "resting" && fb.resumeAt ? Date.parse(fb.resumeAt) : 0;
  return { ok: false, why: `follow-back ${fb.state}`, retryAt: Math.max(resume + 60_000, Date.now() + 60_000) };
}

/** Our share of today's combined cap after reserving room for follow-back's remaining targets. */
function keywordAllowance(cap) {
  const c = followCountsToday();
  const fb = readJson(FB_STATUS) ?? {};
  let fbAlive = false; try { process.kill(fb.pid, 0); fbAlive = true; } catch {}
  const fbCapacity = Math.floor(msUntilNextShanghaiMidnight() / FB_CYCLE_MS) * 10;
  const reserve = fbAlive && loadConfig().followback.enabled ? Math.min(fb.targetsRemaining ?? 0, fbCapacity) : 0;
  return { allowed: Math.max(0, cap - c.combined - reserve), reserve, ...c };
}

async function recheck(credentials, batch) {
  const r = await xRequest(credentials, "GET", "/2/users", { ids: batch.map((c) => c.id).join(","),
    "user.fields": "connection_status,verified,verified_type,public_metrics,protected" });
  if (!r.ok) return null;
  return new Map((r.body?.data ?? []).map((u) => [u.id, u]));
}

async function main() {
  const { credentials } = loadCredentials();
  const me = await xRequest(credentials, "GET", "/2/users/me", { "user.fields": "id,username" });
  if (!me.ok) throw new Error(`GET /2/users/me failed: HTTP ${me.status} ${extractErrorMessage(me.body)}`);
  const userId = me.body.data.id, username = me.body.data.username;

  if (buildOnly || dryRun) {
    const pool = loadPool(dayKey(new Date())) ?? (dryRun ? null : await buildPool(credentials, userId, username));
    const cfg = loadConfig();
    console.log(JSON.stringify({ me: username, pool: pool ? { date: pool.date, count: pool.count, error: pool.error,
      sample: pool.candidates.slice(0, 8).map((c) => `@${c.username} (${c.followers_count})`) } : null,
      allowance: keywordAllowance(cfg.combinedFollowDailyCap), followback: followbackAllowsUs() }, null, 2));
    return;
  }

  if (!acquireLock()) { say("another keywordfollow daemon is running; exiting"); return; }
  say(`daemon started as @${username} (${userId}), pid ${process.pid}`);
  const skip = new Set();
  let inCycle = 0, consecutive403 = 0;

  while (true) {
    const cfg = loadConfig();
    const cap = cfg.combinedFollowDailyCap;
    const day = dayKey(new Date());
    if (!cfg.keywordfollow.enabled) { writeStatus({ state: "disabled" }); await sleep(60_000); continue; }
    const stop = stopFlagToday();
    if (stop) {
      const ms = msUntilNextShanghaiMidnight();
      writeStatus({ state: "stopped_for_day", reason: stop.reason, resumeAt: new Date(Date.now() + ms).toISOString() });
      say(`follows stopped for today (${stop.reason})`); await sleep(Math.min(ms, 30 * 60_000)); continue;
    }

    let pool = loadPool(day);
    if (!pool) {
      writeStatus({ state: "building_pool", day });
      pool = await buildPool(credentials, userId, username);
      if (pool.error && pool.count === 0) {
        writeStatus({ state: "search_failed", error: pool.error, resumeAt: new Date(Date.now() + 60 * 60_000).toISOString() });
        await sleep(60 * 60_000); continue;
      }
    }
    const exclude = excludedIds(userId);
    const triedToday = new Set(readJsonl(KW_LOG).filter((e) => e.day === day).map((e) => e.id));
    const remaining = pool.candidates.filter((c) => !exclude.has(c.id) && !skip.has(c.id) && !triedToday.has(c.id));
    statusBase.pool = { date: pool.date, count: pool.count, remaining: remaining.length, error: pool.error ?? null };

    const allow = keywordAllowance(cap);
    if (remaining.length === 0 || allow.allowed <= 0) {
      const why = remaining.length === 0 ? "pool exhausted" : `combined cap (${allow.combined}/${cap}, ${allow.reserve} reserved for follow-back)`;
      const ms = remaining.length === 0 || allow.combined >= cap ? msUntilNextShanghaiMidnight() : 30 * 60_000;
      writeStatus({ state: remaining.length === 0 ? "pool_exhausted" : "daily_cap", why, resumeAt: new Date(Date.now() + ms).toISOString() });
      say(`${why}; sleeping ${Math.round(Math.min(ms, 30 * 60_000) / 60000)} min`);
      await sleep(Math.min(ms, 30 * 60_000)); continue;
    }

    const gate = followbackAllowsUs();
    if (!gate.ok) {
      writeStatus({ state: "waiting_for_followback", why: gate.why, resumeAt: new Date(gate.retryAt).toISOString() });
      await sleep(Math.min(gate.retryAt - Date.now(), 5 * 60_000)); continue;
    }

    // re-check the next few candidates right before following
    const batch = remaining.slice(0, Math.min(5, CYCLE_SIZE - inCycle));
    const fresh = await recheck(credentials, batch);
    for (const c of batch) {
      const g = followbackAllowsUs();
      if (!g.ok || stopFlagToday()) break;
      if (excludedIds(userId).has(c.id)) { skip.add(c.id); continue; }
      const u = fresh?.get(c.id);
      if (fresh && !u) { skip.add(c.id); logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: "not found/suspended" }); continue; }
      if (u) {
        const cs = u.connection_status ?? [];
        const bad = cs.includes("following") ? "already following" : cs.includes("follow_request_sent") ? "request pending"
          : u.protected ? "protected" : !isBlueV(u) ? "no longer verified"
          : (u.public_metrics?.followers_count ?? 0) >= cfg.keywordfollow.maxFollowers ? "followers >= max" : null;
        if (bad) { skip.add(c.id); logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: bad }); continue; }
      }
      await waitForWindow((w) => { say(`shared follow window full (${w.used}/15min); waiting`); writeStatus({ state: "window_wait", resumeAt: new Date(w.waitUntil).toISOString() }); });
      writeStatus({ state: "following", inCycle });
      const done = await withFollowMutex(async () => {
        if (keywordAllowance(loadConfig().combinedFollowDailyCap).allowed <= 0) return null; // re-check cap inside lock
        const res = await xRequest(credentials, "POST", `/2/users/${userId}/following`, undefined, { target_user_id: c.id });
        const entry = { time: ts(), day, username: c.username, id: c.id, keyword: c.keyword, followers: u?.public_metrics?.followers_count ?? c.followers_count,
          verified_type: u?.verified_type ?? c.verified_type, result: res.ok ? "ok" : `HTTP ${res.status}`, pending: !!res.body?.data?.pending_follow,
          detail: res.ok ? null : extractErrorMessage(res.body), rate: res.rate };
        logKw(entry);
        return { res, entry };
      });
      if (!done) break;
      const { res, entry } = done;
      say(`follow @${c.username} [${c.keyword}] -> ${entry.result} (rate ${res.rate.remaining}/${res.rate.limit})`);
      if (res.ok) { inCycle += 1; consecutive403 = 0; }
      else if (res.status === 429) {
        const wait = Math.max(60_000, Number(res.rate.reset) * 1000 - Date.now() + 5_000 || 15 * 60_000);
        writeStatus({ state: "rate_limited", resumeAt: new Date(Date.now() + wait).toISOString() });
        say(`429; sleeping ${Math.round(wait / 1000)}s`); await sleep(wait); break;
      } else if (res.status === 401) {
        writeStatus({ state: "stopped_auth", detail: entry.detail }); say("401; stopping"); process.exit(2);
      } else if (res.status === 403) {
        skip.add(c.id); consecutive403 += 1;
        if (/limit|unable to follow|too many/i.test(entry.detail ?? "") || consecutive403 >= 2) {
          setStopFlag("keywordfollow", entry.detail || "repeated 403"); say(`403 (${entry.detail}); stopping follows for today`); break;
        }
      } else skip.add(c.id);
      if (inCycle >= CYCLE_SIZE) break;
      await sleep(GAP_MS());
    }
    if (inCycle >= CYCLE_SIZE) {
      const rest = REST_MS();
      inCycle = 0;
      writeStatus({ state: "resting", resumeAt: new Date(Date.now() + rest).toISOString() });
      say(`cycle done; resting ${Math.round(rest / 60000)} min`); await sleep(rest);
    }
  }
}

main().catch((err) => { say(`fatal: ${err.message}`); writeStatus({ state: "fatal", error: err.message }); process.exit(1); });
