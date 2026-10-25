#!/usr/bin/env node
/**
 * Keyword auto-follow daemon for @barrett_tt (zero paid X developer API reads when NO_PAID_READS=1).
 *
 * Pool comes from keyword-candidates/YYYY-MM-DD.json, written by write-keyword-pool.mjs from
 * free X plugin search pages (search_posts_all + author expansions). This process only POSTs
 * follows via the paid write API. NO_PAID_READS defaults on and throws if any GET to api.x.com
 * is attempted (same guard as followback.mjs).
 *
 * Filters (enforced when the pool is built): blue-V, followers ≤ maxFollowers (default 1000, inclusive),
 * Chinese-zone (chineseZoneCheck), not protected, not already followed / never unfollowed,
 * categories AI / 商业 / 两性.
 *
 * Shares combined daily cap + shared work/rest pace with followback.mjs; follow-back has priority.
 *
 *   node keywordfollow.mjs              # daemon (start-keywordfollow.sh)
 *   node keywordfollow.mjs --dry-run    # show pool / allowance, no follows
 *   (pool build): node write-keyword-pool.mjs [--merge]  # free plugin pages → pool file
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadCredentials, xRequest, extractErrorMessage, isBlueV, dayKey, sleep, loadCache, loadAlreadyUnfollowedIds,
  getMe, lookupUsers, USER_LOOKUP_BATCH, creditsBackoffMs,
} from "./unfollow.mjs";
import {
  DATA_DIR, KW_LOG, KW_STATUS, FB_LOG, loadConfig, readJsonl, readJson, followCountsToday,
  withFollowMutex, waitForWindow, stopFlagToday, setStopFlag, msUntilNextShanghaiMidnight, POOL_DIR, followbackReserve, followbackYieldsSlot,
  sharedPace, waitForSharedWork, beginSharedRest, PACE_CYCLE, PACE_GAP_MS, chineseZoneCheck,
} from "./follow-common.mjs";

const LOCK = path.join(DATA_DIR, "keywordfollow.lock");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const buildOnly = args.includes("--build-only");
const refilterOnly = args.includes("--refilter");
const topUp = args.includes("--top-up");
const ME_CACHE_PATH = path.join(DATA_DIR, "me-cache.json");
const IDLE_REREAD_MS = 10 * 60_000;

// Hard guard: keywordfollow must never issue paid GETs. Default ON unless explicitly disabled.
if (process.env.NO_PAID_READS !== "0") {
  process.env.NO_PAID_READS = "1";
}

const ZH_RULE = "tweet lang zh AND (name or bio has >=2 CJK ideographs with kana < han/2); tweet text (>=4 ideographs, kana < han/2) only if name+bio have no CJK ideographs or kana";

const ts = () => new Date().toISOString();
const say = (m) => console.log(`[${ts()}] ${m}`);
const logKw = (e) => fs.appendFileSync(KW_LOG, JSON.stringify(e) + "\n");
let statusBase = {};
const writeStatus = (o) => { statusBase = { ...statusBase, ...o }; try { fs.writeFileSync(KW_STATUS, JSON.stringify({ updated: ts(), pid: process.pid, ...o, counts: followCountsToday(), pool: statusBase.pool }, null, 2)); } catch {} };

function loadMeFromCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(ME_CACHE_PATH, "utf8"));
    if (cached?.id && cached?.username) return { id: String(cached.id), username: cached.username, fromCache: true };
  } catch {}
  return null;
}

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
const REJECTED_PATH = path.join(DATA_DIR, "keyword-rejected-authors.json");

/** Persist author ids rejected by filters so later searches don't re-lookup/re-bill them. */
function loadRejectedAuthors() {
  try {
    const j = JSON.parse(fs.readFileSync(REJECTED_PATH, "utf8"));
    return new Set(Array.isArray(j?.ids) ? j.ids : []);
  } catch { return new Set(); }
}
function saveRejectedAuthors(set) {
  // Cap growth: keep the newest ~50k ids
  const ids = [...set];
  const trimmed = ids.length > 50_000 ? ids.slice(-50_000) : ids;
  try { fs.writeFileSync(REJECTED_PATH, JSON.stringify({ updated: ts(), ids: trimmed })); } catch {}
}
function rememberRejected(set, id) {
  if (!id || set.has(id)) return;
  set.add(id);
}

/** Unused followable candidates from yesterday (and earlier) carried into today's pool. */
function carryOverCandidates(day, exclude) {
  const out = [];
  const files = fs.readdirSync(POOL_DIR).filter((f) => f.endsWith(".json") && f < `${day}.json`).sort().reverse();
  const tried = new Set(readJsonl(KW_LOG).filter((e) => e.result === "ok" || e.result === "skipped").map((e) => e.id));
  for (const f of files.slice(0, 3)) { // look back a few days max
    const pool = readJson(path.join(POOL_DIR, f));
    for (const c of pool?.candidates ?? []) {
      if (!c?.id || exclude.has(c.id) || tried.has(c.id)) continue;
      if (c.zh_ok !== true) continue;
      out.push({ ...c, carriedFrom: pool.date });
      exclude.add(c.id);
    }
  }
  return out;
}

/** Pool-build user lookups use 100 ids/request (pre-follow re-checks stay at USER_LOOKUP_BATCH=14). */
const POOL_USER_LOOKUP_BATCH = 100;

/** Lookup only the author ids we have not already rejected/excluded. */
async function lookupAuthorsForPool(credentials, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  let lookedUp = 0;
  for (let i = 0; i < unique.length; i += POOL_USER_LOOKUP_BATCH) {
    const batch = unique.slice(i, i + POOL_USER_LOOKUP_BATCH);
    const res = await xRequest(credentials, "GET", "/2/users", {
      ids: batch.join(","),
      "user.fields": "verified,verified_type,public_metrics,protected,username,name,description",
    });
    if (!res.ok) {
      const err = new Error(`pool user lookup failed: HTTP ${res.status} ${extractErrorMessage(res.body)}`);
      err.status = res.status; err.rate = res.rate; throw err;
    }
    lookedUp += batch.length;
    for (const u of res.body?.data ?? []) out.set(u.id, u);
  }
  return { users: out, lookedUp };
}

/** Build today's pool; with `base` (today's existing pool) tops it up to poolSize, keeping its candidates.
 *  Search returns tweets only (no user expansions). Known rejects/excludes are skipped before any
 *  GET /2/users, so tooManyFollowers / notVerified authors are not re-billed on later pages/days.
 *  Keywords with better historical add-rate are searched first so the 250 pool fills with fewer pages.
 */
async function buildPool(credentials, userId, username, base = null) {
  const cfg = loadConfig().keywordfollow;
  const day = dayKey(new Date());
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const exclude = excludedIds(userId);
  const rejectedAuthors = loadRejectedAuthors();
  for (const id of rejectedAuthors) exclude.add(id);
  // Skip authors already in earlier pools ONLY if we already followed/tried them;
  // unused Chinese-zone candidates are carried over below instead of discarded.
  for (const c of base?.droppedNonChinese ?? []) { exclude.add(c.id); rememberRejected(rejectedAuthors, c.id); }
  const carried = base ? [] : carryOverCandidates(day, exclude);
  const candidates = new Map([
    ...carried.map((c) => [c.id, c]),
    ...(base?.candidates ?? []).map((c) => [c.id, c]),
  ]);
  const perKeyword = Object.fromEntries(cfg.keywords.map((k) => [k, { pages: 0, posts: 0, added: 0, ...(base?.perKeyword?.[k] ?? {}), done: false }]));
  const tokens = {};
  let pages = base?.searchPages ?? 0, postsRead = base?.postsRead ?? 0, usersRead = base?.usersRead ?? 0, usersSkippedKnown = base?.usersSkippedKnown ?? 0, error = null;
  const rejected = { notVerified: 0, tooManyFollowers: 0, protected: 0, excluded: 0, notChinese: 0, ...(base?.rejected ?? {}) };
  const yieldOf = (k) => {
    const p = perKeyword[k];
    return p.posts > 0 ? p.added / p.posts : 0.05;
  };
  while (candidates.size < cfg.poolSize && pages < cfg.maxSearchPages) {
    // Prefer keywords that historically convert to candidates (fewer wasted User reads).
    const active = cfg.keywords.filter((k) => !perKeyword[k].done).sort((a, b) => yieldOf(b) - yieldOf(a));
    if (!active.length) break;
    for (const kw of active) {
      if (candidates.size >= cfg.poolSize || pages >= cfg.maxSearchPages) break;
      // Tweets only — no author expansion. User reads happen below, after skip-list filter.
      const q = { query: `${/\s/.test(kw) ? `"${kw}"` : kw} lang:zh is:verified -is:retweet`, max_results: "100",
        "tweet.fields": "created_at,lang,author_id,text" };
      if (tokens[kw]) q.next_token = tokens[kw];
      const r = await xRequest(credentials, "GET", "/2/tweets/search/recent", q);
      pages += 1; perKeyword[kw].pages += 1;
      if (r.status === 429) { const w = Math.max(30_000, Number(r.rate.reset) * 1000 - Date.now() + 5_000); say(`search 429; waiting ${Math.round(w / 1000)}s`); await sleep(w); continue; }
      if (r.status === 402) {
        error = { status: 402, detail: extractErrorMessage(r.body) };
        say(`search 402 credits; will back off`); break;
      }
      if (!r.ok) { error = { status: r.status, detail: extractErrorMessage(r.body) }; say(`search failed HTTP ${r.status}: ${error.detail}`); break; }
      const tweets = r.body?.data ?? []; postsRead += tweets.length; perKeyword[kw].posts += tweets.length;
      const needLookup = [];
      const tweetByAuthor = new Map();
      for (const t of tweets) {
        const aid = t.author_id;
        if (!aid || candidates.has(aid) || tweetByAuthor.has(aid)) continue;
        if (t.lang && t.lang !== "zh") { rejected.notChinese++; continue; }
        if (exclude.has(aid) || aid === userId) { rejected.excluded++; usersSkippedKnown += 1; continue; }
        tweetByAuthor.set(aid, t);
        needLookup.push(aid);
      }
      let users = new Map();
      if (needLookup.length) {
        try {
          const looked = await lookupAuthorsForPool(credentials, needLookup);
          users = looked.users;
          usersRead += looked.lookedUp;
        } catch (err) {
          if (err.status === 402) {
            error = { status: 402, detail: err.message };
            say(`user lookup 402 credits; will back off`); break;
          }
          if (err.status === 429) {
            const w = Math.max(30_000, Number(err.rate?.reset) * 1000 - Date.now() + 5_000);
            say(`user lookup 429; waiting ${Math.round(w / 1000)}s`); await sleep(w); continue;
          }
          error = { status: err.status ?? 0, detail: err.message };
          say(`user lookup failed: ${err.message}`); break;
        }
      }
      for (const [aid, t] of tweetByAuthor) {
        if (candidates.size >= cfg.poolSize) break;
        const u = users.get(aid);
        if (!u) continue;
        if (!isBlueV(u)) { rejected.notVerified++; rememberRejected(rejectedAuthors, u.id); exclude.add(u.id); continue; }
        if ((u.public_metrics?.followers_count ?? Infinity) > cfg.maxFollowers) { rejected.tooManyFollowers++; rememberRejected(rejectedAuthors, u.id); exclude.add(u.id); continue; }
        if (u.protected) { rejected.protected++; rememberRejected(rejectedAuthors, u.id); exclude.add(u.id); continue; }
        if (u.username?.toLowerCase() === username.toLowerCase()) { rejected.excluded++; continue; }
        const zh = chineseZoneCheck({ tweetLang: t.lang, name: u.name, bio: u.description, tweetText: t.text });
        if (!zh.ok) { rejected.notChinese++; rememberRejected(rejectedAuthors, u.id); exclude.add(u.id); continue; }
        candidates.set(u.id, { id: u.id, username: u.username, name: u.name, followers_count: u.public_metrics.followers_count,
          verified: u.verified === true, verified_type: u.verified_type ?? null, keyword: kw, tweet_id: t.id, tweet_at: t.created_at,
          tweet_lang: t.lang ?? null, bio: (u.description ?? "").replace(/\s+/g, " ").slice(0, 160),
          text: (t.text ?? "").replace(/\s+/g, " ").slice(0, 200), zh_ok: true, zh_why: zh.why });
        exclude.add(u.id);
        perKeyword[kw].added += 1;
      }
      if (candidates.size >= cfg.poolSize) break; // stop paging once pool is full
      tokens[kw] = r.body?.meta?.next_token;
      if (!tokens[kw]) perKeyword[kw].done = true;
    }
    if (error) break;
  }
  saveRejectedAuthors(rejectedAuthors);
  const pool = { ...(base ?? {}), date: day, built: base?.built ?? ts(), ...(base ? { toppedUp: ts() } : {}),
    source: "x-api-v2-recent-search (user OAuth1, no user expansions)", keywords: cfg.keywords,
    target: cfg.poolSize, count: candidates.size, searchPages: pages, postsRead, usersRead, usersSkippedKnown, perKeyword, rejected, error,
    carriedFromPreviousDays: carried.length,
    filters: { verified: "verified==true or verified_type!=none", maxFollowers: cfg.maxFollowers, protected: false,
      notFollowing: true, notPreviouslyFollowedOrUnfollowed: true, chineseZone: ZH_RULE, query: "<kw> lang:zh is:verified -is:retweet",
      rejectedAuthorsSkipList: true, carryOverUnused: true, searchExpansions: false, lookupOnlyUnknownAuthors: true },
    candidates: [...candidates.values()], droppedNonChinese: base?.droppedNonChinese ?? [] };
  if (candidates.size > 0 || !error) fs.writeFileSync(poolPath(day), JSON.stringify(pool, null, 2));
  say(`pool ${day}: ${pool.count}/${cfg.poolSize} (carried ${carried.length}) from ${pages} search pages (${postsRead} posts, ${usersRead} user reads, skipped-known ${usersSkippedKnown})${error ? `; error HTTP ${error.status}` : ""}`);
  return pool;
}

function loadPool(day) { return readJson(poolPath(day)); }

/**
 * Chinese-zone check for pool candidates that were never checked (pools built before the rule):
 * looks up the matched tweet (lang) and the user (name, bio) and moves failures to droppedNonChinese.
 * Already-followed / already-tried candidates are left alone. Returns null on API failure.
 */
async function refilterPool(credentials, userId, pool) {
  const exclude = excludedIds(userId);
  const tried = new Set(readJsonl(KW_LOG).filter((e) => e.day === pool.date).map((e) => e.id));
  const todo = pool.candidates.filter((c) => c.zh_ok === undefined && !exclude.has(c.id) && !tried.has(c.id));
  if (!todo.length) return { checked: 0, kept: 0, dropped: 0 };
  const tweets = new Map(), users = new Map();
  for (let i = 0; i < todo.length; i += 100) {
    const b = todo.slice(i, i + 100);
    const tr = await xRequest(credentials, "GET", "/2/tweets", { ids: b.map((c) => c.tweet_id).join(","), "tweet.fields": "lang" });
    const ur = await xRequest(credentials, "GET", "/2/users", { ids: b.map((c) => c.id).join(","), "user.fields": "name,description" });
    if (!tr.ok || !ur.ok) { say(`refilter lookup failed (tweets HTTP ${tr.status}, users HTTP ${ur.status})`); return null; }
    for (const t of tr.body?.data ?? []) tweets.set(t.id, t);
    for (const u of ur.body?.data ?? []) users.set(u.id, u);
  }
  const dropped = [];
  for (const c of todo) {
    const t = tweets.get(c.tweet_id), u = users.get(c.id);
    const zh = !u ? { ok: false, why: "user not found" }
      : chineseZoneCheck({ tweetLang: t?.lang ?? (t ? null : "deleted"), name: u.name, bio: u.description, tweetText: t?.text ?? c.text });
    c.tweet_lang = t?.lang ?? null; c.bio = (u?.description ?? "").replace(/\s+/g, " ").slice(0, 160);
    c.zh_ok = zh.ok; c.zh_why = zh.why;
    if (!zh.ok) dropped.push(c);
  }
  const drop = new Set(dropped.map((c) => c.id));
  pool.candidates = pool.candidates.filter((c) => !drop.has(c.id));
  pool.droppedNonChinese = [...(pool.droppedNonChinese ?? []), ...dropped];
  pool.count = pool.candidates.length;
  pool.refiltered = ts(); pool.filters = { ...(pool.filters ?? {}), chineseZone: ZH_RULE };
  fs.writeFileSync(poolPath(pool.date), JSON.stringify(pool, null, 2));
  const res = { checked: todo.length, kept: todo.length - dropped.length, dropped: dropped.length };
  say(`refilter ${pool.date}: checked ${res.checked}, kept ${res.kept} Chinese-zone, dropped ${res.dropped} non-Chinese`);
  return res;
}

/** Candidates the daemon may still follow today: Chinese-checked, not excluded/skipped/tried. */
const followable = (c) => c.zh_ok === true;

/** Follow-back has priority: keyword room = cap − combined − follow-backs still waiting (followbackReserve). */
function keywordAllowance(cap) {
  const r = followbackReserve();
  const c = r.counts;
  return { allowed: Math.max(0, cap - c.combined - r.reserve), followbackReserve: r.reserve, ...c };
}

async function recheck(credentials, batch) {
  try {
    return await lookupUsers(credentials, batch.map((c) => c.id));
  } catch (err) {
    err.recheck = true;
    throw err;
  }
}

async function main() {
  const { credentials, storedUserId, storedUsername } = loadCredentials();
  const noPaid = process.env.NO_PAID_READS === "1";
  // ZERO paid reads by default: never call getMe. Use me-cache.json or credentials store.
  const me = noPaid
    ? (loadMeFromCache() ?? (storedUserId && storedUsername ? { id: String(storedUserId), username: storedUsername, fromCache: true } : null))
    : await getMe(credentials, { storedUserId, storedUsername });
  if (!me?.id) throw new Error("no me-cache.json / stored user id; cannot follow without a paid GET /2/users/me");
  const userId = me.id, username = me.username;

  if (refilterOnly || buildOnly) {
    if (noPaid) {
      console.log(JSON.stringify({
        error: "NO_PAID_READS=1: pool build/refilter via paid API is disabled. Use write-keyword-pool.mjs with free X plugin search pages.",
        helper: "node write-keyword-pool.mjs [--merge]",
        poolDir: POOL_DIR,
      }, null, 2));
      return;
    }
    if (refilterOnly) {
      let pool = loadPool(dayKey(new Date()));
      if (!pool) { console.log("no pool for today"); return; }
      const before = pool.candidates.length;
      const res = await refilterPool(credentials, userId, pool);
      if (!res) process.exit(1);
      if (topUp && pool.candidates.length < loadConfig().keywordfollow.poolSize) pool = await buildPool(credentials, userId, username, pool);
      const exclude = excludedIds(userId);
      const left = pool.candidates.filter((c) => followable(c) && !exclude.has(c.id));
      console.log(JSON.stringify({ date: pool.date, before, ...res, toppedUp: topUp ? pool.candidates.length - (before - res.dropped) : 0,
        count: pool.candidates.length, remainingChinese: left.length, searchPages: pool.searchPages,
        droppedSample: pool.droppedNonChinese.slice(-8).map((c) => `@${c.username} (${c.zh_why})`),
        keptSample: left.slice(0, 8).map((c) => `@${c.username} ${c.name} (${c.zh_why})`) }, null, 2));
      return;
    }
    const pool = await buildPool(credentials, userId, username);
    const cfg = loadConfig();
    const exclude = excludedIds(userId);
    console.log(JSON.stringify({ me: username, pool: { date: pool.date, count: pool.count, error: pool.error,
      remainingChinese: pool.candidates.filter((c) => followable(c) && !exclude.has(c.id)).length },
      allowance: keywordAllowance(cfg.combinedFollowDailyCap) }, null, 2));
    return;
  }

  if (dryRun) {
    const pool = loadPool(dayKey(new Date()));
    const cfg = loadConfig();
    const exclude = excludedIds(userId);
    console.log(JSON.stringify({ me: username, userId, noPaidReads: process.env.NO_PAID_READS,
      pool: pool ? { date: pool.date, count: pool.count, source: pool.source, perCategory: pool.perCategory,
        remainingChinese: pool.candidates.filter((c) => followable(c) && !exclude.has(c.id)).length,
        sample: pool.candidates.filter((c) => followable(c) && !exclude.has(c.id)).slice(0, 8).map((c) => `@${c.username} ${c.name} (${c.followers_count}, ${c.category || c.keyword})`) } : null,
      allowance: keywordAllowance(cfg.combinedFollowDailyCap), reserveForFollowback: followbackReserve(cfg), gate: followbackYieldsSlot(cfg) }, null, 2));
    return;
  }

  if (!acquireLock()) { say("another keywordfollow daemon is running; exiting"); return; }
  say(`daemon started as @${username} (${userId}), pid ${process.pid}, NO_PAID_READS=${process.env.NO_PAID_READS} (file-driven pool, zero paid reads)`);
  const skip = new Set();
  const refilterFailedAt = {};
  let consecutive403 = 0;

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

    // Shared work/rest: sleep through rest (and open a new work window when it ends).
    let pace = await waitForSharedWork((p) => {
      writeStatus({ state: "shared_rest", resumeAt: new Date(p.waitUntil).toISOString(), why: "shared 10-follow window full" });
      say(`shared rest until ${new Date(p.waitUntil).toISOString()}`);
    });

    let pool = loadPool(day);
    if (!pool) {
      if (noPaid) {
        say(`pool file missing for ${day}; waiting for write-keyword-pool.mjs (${Math.round(IDLE_REREAD_MS / 60000)} min)`);
        writeStatus({ state: "idle_no_pool", day, noPaidReads: true, resumeAt: new Date(Date.now() + IDLE_REREAD_MS).toISOString() });
        await sleep(IDLE_REREAD_MS); continue;
      }
      writeStatus({ state: "building_pool", day });
      pool = await buildPool(credentials, userId, username);
      if (pool.error && pool.count === 0) {
        const wait = pool.error?.status === 402 ? creditsBackoffMs() : 60 * 60_000;
        writeStatus({ state: pool.error?.status === 402 ? "credits_backoff" : "search_failed", error: pool.error, resumeAt: new Date(Date.now() + wait).toISOString() });
        await sleep(wait); continue;
      }
    }
    // Pools built before the Chinese-zone rule: check unchecked candidates first (never follow unchecked).
    // Under NO_PAID_READS we cannot refilter via paid API — only follow zh_ok===true entries.
    if (!noPaid && pool.candidates.some((c) => c.zh_ok === undefined) && !refilterFailedAt[day]) {
      const res = await refilterPool(credentials, userId, pool);
      if (!res) refilterFailedAt[day] = Date.now();
    }
    if (refilterFailedAt[day] && Date.now() - refilterFailedAt[day] > 10 * 60_000) delete refilterFailedAt[day];
    const exclude = excludedIds(userId);
    const triedToday = new Set(readJsonl(KW_LOG).filter((e) => e.day === day).map((e) => e.id));
    const remaining = pool.candidates.filter((c) => followable(c) && !exclude.has(c.id) && !skip.has(c.id) && !triedToday.has(c.id));
    statusBase.pool = { date: pool.date, count: pool.count, remaining: remaining.length, error: pool.error ?? null };

    const allow = keywordAllowance(cap);
    if (remaining.length === 0 || allow.allowed <= 0) {
      const capHit = allow.combined >= cap;
      const why = remaining.length === 0 ? "pool exhausted" : capHit ? `combined cap (${allow.combined}/${cap})`
        : `room reserved for follow-back (${allow.combined}/${cap}, ${allow.followbackReserve} follow-backs waiting)`;
      const state = remaining.length === 0 ? "pool_exhausted" : capHit ? "daily_cap" : "reserved_for_followback";
      const wait = state === "reserved_for_followback" ? 5 * 60_000 : 60_000;
      writeStatus({ state, why, resumeAt: new Date(Date.now() + wait).toISOString() });
      say(`${why}; leaving shared window to follow-back`);
      await sleep(wait); continue;
    }

    // Follow-back goes first: wait while it is still claiming this window's slots.
    const gate = followbackYieldsSlot(cfg);
    if (!gate.ok) {
      writeStatus({ state: "waiting_for_followback", why: gate.why, resumeAt: new Date(gate.retryAt).toISOString() });
      await sleep(Math.max(20_000, Math.min(gate.retryAt - Date.now(), 45_000))); continue;
    }

    pace = sharedPace();
    if (pace.remaining <= 0) {
      const r = beginSharedRest("keyword");
      writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
      await sleep(Math.min(r.ms, 5 * 60_000)); continue;
    }

    // Under NO_PAID_READS: trust the plugin-built pool (no paid GET /2/users re-check).
    // Otherwise prefetch up to 14 candidates in ONE GET /2/users.
    const batch = remaining.slice(0, Math.min(noPaid ? pace.remaining : USER_LOOKUP_BATCH, pace.remaining));
    let fresh = null;
    if (!noPaid) {
      try {
        fresh = await recheck(credentials, batch);
      } catch (err) {
        const wait = err.status === 402 ? creditsBackoffMs() : 60_000;
        writeStatus({ state: err.status === 402 ? "credits_backoff" : "recheck_failed", resumeAt: new Date(Date.now() + wait).toISOString() });
        say(`pre-follow re-check failed (${err.message}); retrying in ${Math.round(wait / 1000)}s`); await sleep(wait); continue;
      }
    }
    let took = 0;
    writeStatus({ state: "following", paceUsed: pace.used, paceRemaining: pace.remaining, noPaidReads: noPaid });
    for (const c of batch) {
      if (stopFlagToday() || !loadConfig().keywordfollow.enabled) break;
      pace = sharedPace();
      if (pace.phase !== "work" || pace.remaining <= 0) break;
      if (!followbackYieldsSlot().ok) break; // follow-back wants the slot again
      if (excludedIds(userId).has(c.id)) { skip.add(c.id); continue; }
      if (!noPaid) {
        const u = fresh?.get(c.id);
        if (!u) { skip.add(c.id); logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: "not found/suspended" }); continue; }
        const cs = u.connection_status ?? [];
        const bad = cs.includes("following") ? "already following" : cs.includes("follow_request_sent") ? "request pending"
          : u.protected ? "protected" : !isBlueV(u) ? "no longer verified"
          : (u.public_metrics?.followers_count ?? 0) > cfg.keywordfollow.maxFollowers ? "followers > max" : null;
        const zh = bad ? null : chineseZoneCheck({ tweetLang: c.tweet_lang, name: u.name, bio: u.description, tweetText: c.text });
        if (zh && !zh.ok) {
          skip.add(c.id);
          const rj = loadRejectedAuthors(); rememberRejected(rj, c.id); saveRejectedAuthors(rj);
          logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: `not chinese-zone: ${zh.why}` }); continue;
        }
        if (bad) {
          skip.add(c.id);
          if (bad === "no longer verified" || bad === "followers > max" || bad === "protected") {
            const rj = loadRejectedAuthors(); rememberRejected(rj, c.id); saveRejectedAuthors(rj);
          }
          logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: bad }); continue;
        }
      } else {
        // Pool already filtered; light local guards only.
        if ((c.followers_count ?? 0) > cfg.keywordfollow.maxFollowers) {
          skip.add(c.id); logKw({ time: ts(), day, username: c.username, id: c.id, result: "skipped", detail: "followers > max (pool)" }); continue;
        }
        if (c.zh_ok !== true) { skip.add(c.id); continue; }
      }
      await waitForWindow((w) => { say(`X follow window full (${w.used}/15min); waiting`); writeStatus({ state: "window_wait", resumeAt: new Date(w.waitUntil).toISOString() }); });
      writeStatus({ state: "following", paceUsed: pace.used, paceRemaining: pace.remaining, noPaidReads: noPaid });
      const done = await withFollowMutex(async () => {
        const p2 = sharedPace();
        if (p2.phase !== "work" || p2.remaining <= 0) return null;
        if (keywordAllowance(loadConfig().combinedFollowDailyCap).allowed <= 0) return null;
        if (!followbackYieldsSlot().ok) return null; // follow-back has priority for this slot
        // Paid WRITE only — POST follow. NO_PAID_READS guard blocks any GET.
        const res = await xRequest(credentials, "POST", `/2/users/${userId}/following`, undefined, { target_user_id: c.id });
        const entry = { time: ts(), day, username: c.username, id: c.id, keyword: c.keyword, category: c.category ?? null,
          followers: (fresh?.get(c.id)?.public_metrics?.followers_count) ?? c.followers_count,
          verified_type: (fresh?.get(c.id)?.verified_type) ?? c.verified_type, result: res.ok ? "ok" : `HTTP ${res.status}`, pending: !!res.body?.data?.pending_follow,
          detail: res.ok ? null : extractErrorMessage(res.body), rate: res.rate };
        logKw(entry);
        return { res, entry };
      });
      if (!done) break;
      const { res, entry } = done;
      say(`follow @${c.username} [${c.keyword}] -> ${entry.result} (rate ${res.rate.remaining}/${res.rate.limit}, pace ${sharedPace().used}/${PACE_CYCLE})`);
      if (res.ok) { took += 1; consecutive403 = 0; }
      else if (res.status === 429) {
        const wait = Math.max(60_000, Number(res.rate.reset) * 1000 - Date.now() + 5_000 || 15 * 60_000);
        writeStatus({ state: "rate_limited", resumeAt: new Date(Date.now() + wait).toISOString() });
        say(`429; sleeping ${Math.round(wait / 1000)}s`); await sleep(wait); break;
      } else if (res.status === 402) {
        const wait = creditsBackoffMs();
        writeStatus({ state: "credits_backoff", resumeAt: new Date(Date.now() + wait).toISOString() });
        say(`402 credits; backing off ${Math.round(wait / 1000)}s`); await sleep(wait); break;
      } else if (res.status === 401) {
        writeStatus({ state: "stopped_auth", detail: entry.detail }); say("401; stopping"); process.exit(2);
      } else if (res.status === 403) {
        skip.add(c.id); consecutive403 += 1;
        if (/limit|unable to follow|too many/i.test(entry.detail ?? "") || consecutive403 >= 2) {
          setStopFlag("keywordfollow", entry.detail || "repeated 403"); say(`403 (${entry.detail}); stopping follows for today`); break;
        }
      } else skip.add(c.id);
      pace = sharedPace();
      if (pace.remaining <= 0) {
        const r = beginSharedRest("keyword");
        writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
        say(`shared window full; resting ${Math.round(r.ms / 60000)} min`); await sleep(Math.min(r.ms, 5 * 60_000));
        break;
      }
      await sleep(PACE_GAP_MS());
    }
    // Brief pause before re-checking the follow-back gate / pace.
    await sleep(5_000);
  }
}

main().catch((err) => { say(`fatal: ${err.message}`); writeStatus({ state: "fatal", error: err.message }); process.exit(1); });
