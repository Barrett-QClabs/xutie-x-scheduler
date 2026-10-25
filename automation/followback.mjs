#!/usr/bin/env node
/**
 * Follow-back daemon for @barrett_tt (zero paid X developer API reads).
 *
 * Targets come from /workspace/x-unfollow/followback-targets.json, written by the
 * agent from the free X plugin (user-X get_users_me_followers). This process only
 * POSTs follows via the paid write API. NO_PAID_READS defaults on and throws if any
 * GET to api.x.com is attempted.
 *
 *   node followback.mjs            # daemon (run via start-followback.sh)
 *   node followback.mjs --dry-run  # one pass, prints planned targets, no writes
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadCredentials, xRequest, extractErrorMessage, isBlueV, sleep,
  loadAlreadyUnfollowedIds, creditsBackoffMs,
} from "./unfollow.mjs";
import {
  DATA_DIR, loadConfig, followCountsToday, withFollowMutex, waitForWindow, stopFlagToday, setStopFlag,
  msUntilNextShanghaiMidnight as msToMidnight, followbackReserve,
  sharedPace, waitForSharedWork, beginSharedRest, PACE_CYCLE, PACE_GAP_MS,
} from "./follow-common.mjs";

const FB_LOG = path.join(DATA_DIR, "followback.jsonl");
const LOCK = path.join(DATA_DIR, "followback.lock");
const STATUS = path.join(DATA_DIR, "followback.status.json");
const TARGETS_PATH = path.join(DATA_DIR, "followback-targets.json");
const ME_CACHE_PATH = path.join(DATA_DIR, "me-cache.json");
const IDLE_REREAD_MS = 10 * 60_000; // re-read targets file when empty
const dryRun = process.argv.includes("--dry-run");

// Hard guard: followback must never issue paid GETs. Default ON unless explicitly disabled.
if (process.env.NO_PAID_READS !== "0") {
  process.env.NO_PAID_READS = "1";
}

let DAILY_CAP = loadConfig().combinedFollowDailyCap;

const ts = () => new Date().toISOString();
const say = (m) => console.log(`[${ts()}] ${m}`);
const logFb = (e) => fs.appendFileSync(FB_LOG, JSON.stringify(e) + "\n");
const writeStatus = (o) => { try { fs.writeFileSync(STATUS, JSON.stringify({ updated: ts(), pid: process.pid, ...o }, null, 2)); } catch {} };

function readFbLog() {
  if (!fs.existsSync(FB_LOG)) return [];
  return fs.readFileSync(FB_LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function todayFollowCount() { return followCountsToday().combined; }
function fbRoom() { return { room: DAILY_CAP - todayFollowCount() }; }
const msUntilNextShanghaiMidnight = msToMidnight;

function loadMeFromCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(ME_CACHE_PATH, "utf8"));
    if (cached?.id && cached?.username) return { id: String(cached.id), username: cached.username, fromCache: true };
  } catch {}
  return null;
}

/** Read plugin-produced targets file. Shape: [{id, username, verified_type, fetchedAt}, ...] or {targets:[...]}. */
function loadTargetsFile() {
  if (!fs.existsSync(TARGETS_PATH)) return { targets: [], mtime: null, error: "missing" };
  try {
    const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.targets) ? raw.targets : []);
    const st = fs.statSync(TARGETS_PATH);
    return { targets: list.filter((t) => t?.id), mtime: st.mtime.toISOString(), error: null };
  } catch (err) {
    return { targets: [], mtime: null, error: err.message };
  }
}

/**
 * Filter file targets: blue-V only, not already followed by us (followback/keyword logs),
 * never-unfollowed, not skipped this session. connection_status from the plugin already
 * selected followed_by && !following; we trust the file + logs.
 */
function computeTargets(fileTargets, extraFollowed, skipIds) {
  const unfollowed = loadAlreadyUnfollowedIds();
  const done = new Set(readFbLog().filter((e) => e.result === "ok" || e.pending).map((e) => e.id));
  // Also treat keyword-follow ok/pending as already followed (don't re-follow).
  try {
    const kw = path.join(DATA_DIR, "keywordfollow.jsonl");
    if (fs.existsSync(kw)) {
      for (const line of fs.readFileSync(kw, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.id && (e.result === "ok" || e.pending)) done.add(e.id);
        } catch {}
      }
    }
  } catch {}
  return fileTargets
    .filter((u) => {
      if (!u?.id) return false;
      if (extraFollowed.has(u.id) || unfollowed.has(u.id) || done.has(u.id) || skipIds.has(u.id)) return false;
      // Accept verified / verified_type from file; isBlueV-compatible shape
      const shape = { verified: u.verified, verified_type: u.verified_type };
      if (u.verified === undefined && u.verified_type === undefined) {
        // File entries from helper always set verified_type for blue; if missing, treat as blue (plugin already filtered)
        return true;
      }
      return isBlueV(shape) || u.verified_type === "blue" || u.verified === true;
    })
    .map((u) => ({
      id: String(u.id),
      username: u.username ?? "",
      blueV: true,
      protected: !!u.protected,
      verified_type: u.verified_type ?? "blue",
    }));
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

async function main() {
  const { credentials, storedUserId, storedUsername } = loadCredentials();
  // ZERO paid reads: never call getMe. Use me-cache.json or credentials store.
  const me = loadMeFromCache()
    ?? (storedUserId && storedUsername ? { id: String(storedUserId), username: storedUsername, fromCache: true } : null);
  if (!me?.id) {
    throw new Error("no me-cache.json / stored user id; cannot follow without a paid GET /2/users/me");
  }
  const userId = me.id;

  if (dryRun) {
    const { targets: fileTargets, mtime, error } = loadTargetsFile();
    const targets = computeTargets(fileTargets, new Set(), new Set());
    console.log(JSON.stringify({
      dryRun: true, me: me.username, userId, noPaidReads: process.env.NO_PAID_READS,
      targetsFile: TARGETS_PATH, targetsFileMtime: mtime, targetsFileError: error,
      fileEntries: fileTargets.length, followBackTargets: targets.length,
      followedToday: todayFollowCount(), dailyCap: DAILY_CAP, room: fbRoom().room,
      reserveForFollowback: followbackReserve(),
      firstCycle: targets.slice(0, PACE_CYCLE).map((t) => t.username + (t.protected ? "(protected)" : "")),
    }, null, 2));
    return;
  }

  if (!acquireLock()) { say("another followback daemon is running; exiting"); return; }
  say(`daemon started as @${me.username} (${userId}), pid ${process.pid}, NO_PAID_READS=${process.env.NO_PAID_READS} (file-driven targets, zero paid reads)`);
  const extraFollowed = new Set();
  const skipIds = new Set();
  let lastTargets = 0;

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

    const { targets: fileTargets, mtime, error } = loadTargetsFile();
    if (error === "missing") say(`targets file missing (${TARGETS_PATH}); idling`);
    else if (error) say(`targets file error: ${error}`);
    const targets = computeTargets(fileTargets, extraFollowed, skipIds);
    const today = todayFollowCount();
    lastTargets = targets.length;
    writeStatus({
      state: "cycle", targetsRemaining: targets.length, followedToday: today,
      counts: followCountsToday(), dailyCap: DAILY_CAP,
      targetsFileMtime: mtime, targetsFileEntries: fileTargets.length, noPaidReads: true,
    });

    if (today >= DAILY_CAP) {
      const ms = msUntilNextShanghaiMidnight();
      say(`daily cap ${DAILY_CAP} reached; sleeping ${Math.round(ms / 60000)} min`);
      writeStatus({ state: "daily_cap", targetsRemaining: targets.length, followedToday: today, dailyCap: DAILY_CAP, resumeAt: new Date(Date.now() + ms).toISOString() });
      await sleep(ms); continue;
    }

    let pace = await waitForSharedWork((p) => {
      writeStatus({ state: "shared_rest", targetsRemaining: targets.length, followedToday: today, counts: followCountsToday(), dailyCap: DAILY_CAP, resumeAt: new Date(p.waitUntil).toISOString() });
      say(`shared rest until ${new Date(p.waitUntil).toISOString()}`);
    });

    const room = fbRoom();
    if (room.room <= 0) continue;

    if (targets.length === 0) {
      say(`no follow-back targets in file; re-reading in ${Math.round(IDLE_REREAD_MS / 60000)} min`);
      writeStatus({
        state: "idle", targetsRemaining: 0, followedToday: today, counts: followCountsToday(),
        dailyCap: DAILY_CAP, resumeAt: new Date(Date.now() + IDLE_REREAD_MS).toISOString(),
        targetsFileMtime: mtime, noPaidReads: true,
      });
      await sleep(IDLE_REREAD_MS);
      continue;
    }

    pace = sharedPace();
    if (pace.remaining <= 0) {
      const r = beginSharedRest("followback");
      writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
      await sleep(Math.min(r.ms, 5 * 60_000)); continue;
    }

    // Take remaining shared-pace slots (no paid lookupUsers — trust plugin-produced file).
    const batch = targets.slice(0, Math.min(pace.remaining, room.room));
    writeStatus({
      state: "following", targetsRemaining: targets.length, followedToday: todayFollowCount(),
      counts: followCountsToday(), dailyCap: DAILY_CAP, paceUsed: pace.used, paceRemaining: pace.remaining, noPaidReads: true,
    });

    let consecutive403 = 0;
    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      if (todayFollowCount() >= DAILY_CAP || stopFlagToday()) break;
      pace = sharedPace();
      if (pace.phase === "rest" || pace.remaining <= 0 || fbRoom().room <= 0 || stopFlagToday()) break;

      await waitForWindow((w) => {
        say(`X follow window full (${w.used}/15min); waiting`);
        writeStatus({ state: "window_wait", targetsRemaining: lastTargets - i, resumeAt: new Date(w.waitUntil).toISOString(), followedToday: todayFollowCount() });
      });
      writeStatus({
        state: "following", targetsRemaining: lastTargets - i, followedToday: todayFollowCount(),
        counts: followCountsToday(), dailyCap: DAILY_CAP, paceUsed: pace.used, paceRemaining: pace.remaining, noPaidReads: true,
      });

      const done = await withFollowMutex(async () => {
        const p2 = sharedPace();
        if (p2.phase !== "work" || p2.remaining <= 0) return null;
        if (fbRoom().room <= 0) return null;
        // Paid WRITE only — POST follow. NO_PAID_READS guard blocks any GET.
        const res = await xRequest(credentials, "POST", `/2/users/${userId}/following`, undefined, { target_user_id: t.id });
        const entry = {
          time: ts(), username: t.username, id: t.id, blueV: t.blueV, protected: t.protected,
          verified_type: t.verified_type,
          result: res.ok ? "ok" : `HTTP ${res.status}`, pending: !!res.body?.data?.pending_follow,
          detail: res.ok ? null : extractErrorMessage(res.body), rate: res.rate,
        };
        logFb(entry);
        return { res, entry };
      });

      if (!done) {
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
      } else if (res.status === 402) {
        const w = creditsBackoffMs();
        writeStatus({ state: "credits_backoff", resumeAt: new Date(Date.now() + w).toISOString() });
        say(`402 credits; backing off ${Math.round(w / 1000)}s`); await sleep(w); break;
      } else if (res.status === 401) {
        writeStatus({ state: "stopped_auth", detail: entry.detail });
        say("401 unauthorized; stopping daemon"); process.exit(2);
      } else if (res.status === 403) {
        skipIds.add(t.id); consecutive403 += 1;
        if (/limit|unable to follow|too many/i.test(entry.detail ?? "")) {
          setStopFlag("followback", entry.detail);
          say(`follow limit 403 (${entry.detail}); stopping follows for today`);
          break;
        }
        if (consecutive403 >= 2) { say("two 403s in a row; ending cycle early"); break; }
      } else {
        skipIds.add(t.id);
      }
      pace = sharedPace();
      if (pace.remaining <= 0) {
        const r = beginSharedRest("followback");
        writeStatus({ state: "shared_rest", resumeAt: r.restUntil });
        say(`shared window full; resting ${Math.round(r.ms / 60000)} min`);
        await sleep(Math.min(r.ms, 5 * 60_000));
        break;
      }
      await sleep(PACE_GAP_MS());
    }

    pace = sharedPace();
    if (pace.phase === "work" && pace.remaining > 0 && computeTargets(loadTargetsFile().targets, extraFollowed, skipIds).length === 0) {
      writeStatus({
        state: "window_yield", why: "no more follow-back targets; remaining slots go to keyword",
        targetsRemaining: 0, followedToday: todayFollowCount(), counts: followCountsToday(),
        dailyCap: DAILY_CAP, paceUsed: pace.used, paceRemaining: pace.remaining, noPaidReads: true,
      });
    }
    await sleep(5_000);
  }
}

main().catch((err) => { say(`fatal: ${err.message}`); writeStatus({ state: "fatal", error: err.message }); process.exit(1); });
