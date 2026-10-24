#!/usr/bin/env node
/**
 * Follow-back daemon for @barrett_tt.
 * Targets: accounts that follow the user but the user does not follow.
 * Never follows anyone the unfollow script has unfollowed (log.jsonl).
 *
 *   node followback.mjs            # daemon (run via start-followback.sh)
 *   node followback.mjs --dry-run  # one pass, prints planned targets, no writes
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCredentials, xRequest, extractErrorMessage, isBlueV, dayKey, sleep,
  loadCache, saveCache, pageUsers, loadAlreadyUnfollowedIds,
} from "./unfollow.mjs";
import {
  DATA_DIR, loadConfig, followCountsToday, withFollowMutex, waitForWindow, stopFlagToday, setStopFlag,
  msUntilNextShanghaiMidnight as msToMidnight, keywordReserve, keywordYieldsSlot,
  sharedPace, waitForSharedWork, beginSharedRest, PACE_CYCLE, PACE_GAP_MS,
} from "./follow-common.mjs";

const FB_LOG = path.join(DATA_DIR, "followback.jsonl");
const LOCK = path.join(DATA_DIR, "followback.lock");
const STATUS = path.join(DATA_DIR, "followback.status.json");
// Combined daily follow cap (follow-back + keyword follow) from automation.config.json (default 350).
// SHARED PACE + KEYWORD PRIORITY (since 2026-10-24): both daemons share one work/rest cycle
// (≤10 successful follows total per window, then shared 10–15 min rest with zero follows).
// Keyword gets first dibs on the 10 slots; this daemon fills remaining slots in the same window
// (keywordYieldsSlot), and only with room not reserved for keyword (keywordReserve).
let DAILY_CAP = loadConfig().combinedFollowDailyCap;
const REFRESH_MIN_MS = 30 * 60_000;
const REFRESH_MAX_MS = 60 * 60_000;
const dryRun = process.argv.includes("--dry-run");

const ts = () => new Date().toISOString();
const say = (m) => console.log(`[${ts()}] ${m}`);
const logFb = (e) => fs.appendFileSync(FB_LOG, JSON.stringify(e) + "\n");
const writeStatus = (o) => { try { fs.writeFileSync(STATUS, JSON.stringify({ updated: ts(), pid: process.pid, ...o }, null, 2)); } catch {} };

function readFbLog() {
  if (!fs.existsSync(FB_LOG)) return [];
  return fs.readFileSync(FB_LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
// Combined count (follow-back + keyword follow) so the shared daily cap is enforced.
function todayFollowCount() { return followCountsToday().combined; }
// Room follow-back may use today = cap - combined - keyword reserve.
function fbRoom() { const r = keywordReserve(); return { room: DAILY_CAP - r.counts.combined - r.reserve, reserve: r.reserve }; }
const msUntilNextShanghaiMidnight = msToMidnight;

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

let lastRefresh = 0;
let lastTargets = 0;
let refreshInterval = REFRESH_MIN_MS;
async function getLists(credentials, userId, force = false) {
  const cache = loadCache();
  const age = cache?.timestamp ? Date.now() - Date.parse(cache.timestamp) : Infinity;
  if (!force && cache && age < refreshInterval) return cache;
  try {
    const following = await pageUsers(credentials, "following", userId);
    const followers = await pageUsers(credentials, "followers", userId);
    const fresh = { timestamp: ts(), userId, following: following.users, followers: followers.users,
      meta: { by: "followback", followingRate: following.rate, followersRate: followers.rate } };
    saveCache(fresh);
    lastRefresh = Date.now();
    refreshInterval = REFRESH_MIN_MS + Math.floor(Math.random() * (REFRESH_MAX_MS - REFRESH_MIN_MS));
    say(`refreshed lists: following=${fresh.following.length} followers=${fresh.followers.length}`);
    return fresh;
  } catch (err) {
    if (cache) { say(`list refresh failed (${err.message}); using cache from ${cache.timestamp}`); return cache; }
    throw err;
  }
}

function computeTargets(lists, extraFollowed, skipIds) {
  const following = new Set(lists.following.map((u) => u.id));
  const unfollowed = loadAlreadyUnfollowedIds(); // never re-follow someone the unfollow script dropped
  const done = new Set(readFbLog().filter((e) => e.result === "ok" || e.pending).map((e) => e.id));
  // followers endpoint lists newest followers first; follow back oldest-waiting first
  return lists.followers
    .filter((u) => u?.id && !following.has(u.id) && !extraFollowed.has(u.id) && !unfollowed.has(u.id) && !done.has(u.id) && !skipIds.has(u.id))
    .map((u) => ({ id: u.id, username: u.username ?? "", blueV: isBlueV(u), protected: !!u.protected }))
    .reverse();
}

async function main() {
  const { credentials } = loadCredentials();
  const me = await xRequest(credentials, "GET", "/2/users/me", { "user.fields": "id,username" });
  if (!me.ok) throw new Error(`GET /2/users/me failed: HTTP ${me.status} ${extractErrorMessage(me.body)}`);
  const userId = me.body.data.id;

  if (dryRun) {
    const lists = await getLists(credentials, userId, false);
    const targets = computeTargets(lists, new Set(), new Set());
    console.log(JSON.stringify({ dryRun: true, me: me.body.data.username, cacheTimestamp: lists.timestamp,
      following: lists.following.length, followers: lists.followers.length,
      followBackTargets: targets.length, blueV: targets.filter((t) => t.blueV).length, protected: targets.filter((t) => t.protected).length,
      followedToday: todayFollowCount(), dailyCap: DAILY_CAP,
      firstCycle: targets.slice(0, CYCLE_SIZE).map((t) => t.username + (t.protected ? "(protected)" : "")) }, null, 2));
    return;
  }

  if (!acquireLock()) { say("another followback daemon is running; exiting"); return; }
  say(`daemon started as @${me.body.data.username} (${userId}), pid ${process.pid}`);
  const extraFollowed = new Set();
  const skipIds = new Set(); // per-target hard failures this session

  while (true) {
    const cfg = loadConfig();
    DAILY_CAP = cfg.combinedFollowDailyCap;
    if (!cfg.followback.enabled) {
      writeStatus({ state: "disabled", followedToday: todayFollowCount(), counts: followCountsToday() });
      await sleep(60_000); continue;
    }
    const stop = stopFlagToday();
    if (stop) {
      const ms = msUntilNextShanghaiMidnight();
      say(`follows stopped for today (${stop.reason}); sleeping ${Math.round(ms / 60000)} min`);
      writeStatus({ state: "stopped_for_day", reason: stop.reason, followedToday: todayFollowCount(), resumeAt: new Date(Date.now() + ms).toISOString() });
      await sleep(Math.min(ms, 30 * 60_000)); continue;
    }
    const lists = await getLists(credentials, userId);
    const targets = computeTargets(lists, extraFollowed, skipIds);
    const today = todayFollowCount();
    lastTargets = targets.length;
    writeStatus({ state: "cycle", targetsRemaining: targets.length, followedToday: today, counts: followCountsToday(), dailyCap: DAILY_CAP, cacheTimestamp: lists.timestamp });
    if (today >= DAILY_CAP) {
      const ms = msUntilNextShanghaiMidnight();
      say(`daily cap ${DAILY_CAP} reached; sleeping ${Math.round(ms / 60000)} min`);
      writeStatus({ state: "daily_cap", targetsRemaining: targets.length, followedToday: today, dailyCap: DAILY_CAP, resumeAt: new Date(Date.now() + ms).toISOString() });
      await sleep(ms); continue;
    }
    // Shared work/rest: sleep through rest; only follow during a work window.
    let pace = await waitForSharedWork((p) => {
      writeStatus({ state: "shared_rest", targetsRemaining: targets.length, followedToday: today, counts: followCountsToday(), dailyCap: DAILY_CAP, resumeAt: new Date(p.waitUntil).toISOString() });
      say(`shared rest until ${new Date(p.waitUntil).toISOString()}`);
    });

    const room = fbRoom();
    if (room.room <= 0) {
      say(`no room left for follow-back (${today}/${DAILY_CAP}, ${room.reserve} reserved for keyword follow); re-checking in 5 min`);
      writeStatus({ state: "reserved_for_keyword", targetsRemaining: targets.length, followedToday: today, counts: followCountsToday(), dailyCap: DAILY_CAP, keywordReserve: room.reserve, resumeAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      await sleep(5 * 60_000); continue;
    }
    if (targets.length === 0) {
      say("no follow-back targets; sleeping until next refresh");
      writeStatus({ state: "idle", targetsRemaining: 0, followedToday: today, counts: followCountsToday(), dailyCap: DAILY_CAP, resumeAt: new Date(Date.now() + refreshInterval).toISOString() });
      await sleep(refreshInterval); await getLists(credentials, userId, true); continue;
    }

    pace = sharedPace();
    if (pace.remaining <= 0) {
      const r = beginSharedRest("followback");
      writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
      await sleep(Math.min(r.ms, 5 * 60_000)); continue;
    }

    // Fill remaining slots in this shared window (keyword already had priority).
    const batch = targets.slice(0, Math.min(pace.remaining, room.room));
    let consecutive403 = 0;
    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      if (todayFollowCount() >= DAILY_CAP || stopFlagToday()) break;
      // Wait while keyword is actively claiming slots in this window.
      let gate = keywordYieldsSlot();
      while (!gate.ok) {
        writeStatus({ state: "waiting_for_keyword", why: gate.why, targetsRemaining: lastTargets - i, followedToday: todayFollowCount(), counts: followCountsToday(), dailyCap: DAILY_CAP, resumeAt: new Date(gate.retryAt).toISOString() });
        await sleep(Math.max(20_000, Math.min(gate.retryAt - Date.now(), 45_000)));
        // If shared rest started while we waited, bail to outer loop.
        if (sharedPace().phase === "rest") break;
        gate = keywordYieldsSlot();
      }
      pace = sharedPace();
      if (pace.phase === "rest" || pace.remaining <= 0 || fbRoom().room <= 0 || stopFlagToday()) break;
      await waitForWindow((w) => { say(`X follow window full (${w.used}/15min); waiting`); writeStatus({ state: "window_wait", resumeAt: new Date(w.waitUntil).toISOString(), followedToday: todayFollowCount() }); });
      const done = await withFollowMutex(async () => {
        const p2 = sharedPace();
        if (p2.phase !== "work" || p2.remaining <= 0) return null;
        if (fbRoom().room <= 0) return null;
        if (!keywordYieldsSlot().ok) return null; // keyword grabbed the slot
        const res = await xRequest(credentials, "POST", `/2/users/${userId}/following`, undefined, { target_user_id: t.id });
        const entry = { time: ts(), username: t.username, id: t.id, blueV: t.blueV, protected: t.protected,
          result: res.ok ? "ok" : `HTTP ${res.status}`, pending: !!res.body?.data?.pending_follow,
          detail: res.ok ? null : extractErrorMessage(res.body), rate: res.rate };
        logFb(entry);
        return { res, entry };
      });
      if (!done) {
        // lost the race or window full — re-check outer loop
        if (sharedPace().remaining <= 0) {
          const r = beginSharedRest("followback");
          writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
          await sleep(Math.min(r.ms, 5 * 60_000));
        } else await sleep(15_000);
        break;
      }
      const { res, entry } = done;
      say(`follow ${t.username} -> ${entry.result}${entry.pending ? " (pending)" : ""} (rate ${res.rate.remaining}/${res.rate.limit}, pace ${sharedPace().used}/${PACE_CYCLE})`);
      if (res.ok) { extraFollowed.add(t.id); consecutive403 = 0; }
      else if (res.status === 429) {
        const reset = Number(res.rate.reset) * 1000;
        const wait = Math.max(60_000, (Number.isFinite(reset) ? reset - Date.now() : 15 * 60_000) + 5_000);
        say(`429 rate limit; waiting ${Math.round(wait / 1000)}s until reset`);
        writeStatus({ state: "rate_limited", resumeAt: new Date(Date.now() + wait).toISOString() });
        await sleep(wait); break;
      } else if (res.status === 401) {
        writeStatus({ state: "stopped_auth", detail: entry.detail });
        say("401 unauthorized; stopping daemon"); process.exit(2);
      } else if (res.status === 403) {
        skipIds.add(t.id); consecutive403 += 1;
        if (/limit|unable to follow|too many/i.test(entry.detail ?? "")) { setStopFlag("followback", entry.detail); say(`follow limit 403 (${entry.detail}); stopping follows for today`); break; }
        if (consecutive403 >= 2) { say("two 403s in a row; ending cycle early"); break; }
      } else {
        skipIds.add(t.id);
      }
      pace = sharedPace();
      if (pace.remaining <= 0) {
        const r = beginSharedRest("followback");
        writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
        say(`shared window full; resting ${Math.round(r.ms / 60000)} min`); await sleep(Math.min(r.ms, 5 * 60_000));
        break;
      }
      await sleep(PACE_GAP_MS());
    }
    // Brief pause so we re-enter waitForSharedWork / keyword gate cleanly.
    await sleep(5_000);
  }
}

main().catch((err) => { say(`fatal: ${err.message}`); writeStatus({ state: "fatal", error: err.message }); process.exit(1); });
