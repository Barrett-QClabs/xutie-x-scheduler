#!/usr/bin/env node
/**
 * Mark followed accounts inactive-24h via FREE X reads (for the unfollow pool).
 * Never calls the paid API. Agent / routine runs the MCP calls; this script plans + saves + applies.
 *
 *   node write-following-activity.mjs --plan [--limit N]
 *   node write-following-activity.mjs --save lookup <mcp-output-file>
 *   node write-following-activity.mjs --apply
 *   node write-following-activity.mjs --report
 *
 * Lookup (1 call per ≤25 users): x.get_users_by_usernames
 *   usernames=<≤25>, user.fields=most_recent_tweet_id,
 *   expansions=most_recent_tweet_id, post.fields=created_at,referenced_tweets,in_reply_to_user_id
 *
 * Prefer mutual follows (inactive-24h tier now unfollows mutuals, last); oldest-checked first.
 * Skips whitelist and accounts followed < minFollowAgeHours (from follow logs).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, FB_LOG, KW_LOG, loadConfig, readJsonl } from "./follow-common.mjs";
import { loadCache, loadWhitelist, loadAlreadyUnfollowedIds } from "./unfollow.mjs";
import {
  ACTIVITY_PATH, ACTIVITY_PAGES_DIR, LOOKUP_BATCH, inactiveCfg, loadActivityState, saveActivityState,
  inactiveStatus, mostRecentKind, recentlyFollowedIds,
} from "./following-activity.mjs";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const cfg = loadConfig();
const icfg = inactiveCfg(cfg);

function parseMcpFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  throw new Error(`no JSON object in ${file}`);
}

function followerIdSet(cache) {
  return new Set((cache?.followers ?? []).map((u) => u?.id).filter(Boolean).map(String));
}

/** Candidates to check: currently following, not whitelist, not already-unfollowed, preferably non-mutual. */
function checkQueue(limit) {
  const cache = loadCache();
  const following = cache?.following ?? [];
  const followers = followerIdSet(cache);
  const whitelist = loadWhitelist();
  const skip = loadAlreadyUnfollowedIds();
  const recent = recentlyFollowedIds(icfg.minFollowAgeHours);
  const state = loadActivityState();
  const rows = [];
  for (const u of following) {
    if (!u?.id || !u?.username) continue;
    const id = String(u.id);
    if (skip.has(u.id) || skip.has(id)) continue;
    if (whitelist.has(String(u.username).toLowerCase())) continue;
    if (recent.has(id)) continue; // too new to unfollow anyway
    const mutual = followers.has(id);
    const prev = state.accounts[id];
    const checkedAt = prev?.checked_at ? Date.parse(prev.checked_at) : 0;
    rows.push({
      id, username: u.username, mutual,
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
    });
  }
  // Prefer mutuals (2026-10-29 17:02: non-mutuals are already in earlier tiers; inactive tier catches mutuals); oldest-checked first.
  rows.sort((a, b) => {
    if (a.mutual !== b.mutual) return a.mutual ? -1 : 1;
    return a.checkedAt - b.checkedAt;
  });
  return rows.slice(0, limit);
}

if (argv.includes("--save")) {
  const kind = opt("--save");
  const src = argv[argv.indexOf("--save") + 2];
  if (kind !== "lookup" || !src) { console.error("usage: --save lookup <file>"); process.exit(1); }
  const response = parseMcpFile(src);
  fs.mkdirSync(ACTIVITY_PAGES_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const out = path.join(ACTIVITY_PAGES_DIR, `lookup-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(out, JSON.stringify({ kind: "lookup", checked_at: new Date().toISOString(), response }));
  console.log(JSON.stringify({ saved: out, kind: "lookup", users: response?.data?.length ?? 0 }));
  process.exit(0);
}

if (argv.includes("--apply")) {
  const state = loadActivityState();
  state.windowHours = icfg.windowHours;
  const files = fs.existsSync(ACTIVITY_PAGES_DIR)
    ? fs.readdirSync(ACTIVITY_PAGES_DIR).filter((f) => /^lookup-.*\.json$/.test(f)).sort()
    : [];
  let applied = 0;
  const cutoffOld = Date.now() - 7 * 86400_000;
  for (const f of files) {
    const p = path.join(ACTIVITY_PAGES_DIR, f);
    let w; try { w = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (Date.parse(w.checked_at) < cutoffOld) { try { fs.unlinkSync(p); } catch {} continue; }
    const r = w.response ?? {};
    const checked = w.checked_at;
    const posts = new Map([...(r.includes?.posts ?? []), ...(r.includes?.tweets ?? [])].map((t) => [String(t.id), t]));
    for (const u of r.data ?? []) {
      const id = String(u.id);
      const t = u.most_recent_tweet_id ? posts.get(String(u.most_recent_tweet_id)) : null;
      const prev = state.accounts[id] ?? {};
      // Prefer newer checks
      if (prev.checked_at && Date.parse(prev.checked_at) > Date.parse(checked)) continue;
      const row = {
        username: u.username ?? prev.username ?? "",
        checked_at: checked,
        source: "free:get_users_by_usernames.most_recent_tweet_id",
        last_any_at: null,
        last_any_id: null,
        last_any_kind: "none",
      };
      if (t?.created_at) {
        row.last_any_at = t.created_at;
        row.last_any_id = t.id;
        row.last_any_kind = mostRecentKind(t);
      } else if (!u.most_recent_tweet_id) {
        row.last_any_kind = "none";
      } else {
        // tweet id present but expansion missing — keep previous last_any if any; still stamp checked
        row.last_any_at = prev.last_any_at ?? null;
        row.last_any_id = prev.last_any_id ?? null;
        row.last_any_kind = prev.last_any_kind ?? "unknown";
      }
      state.accounts[id] = row;
      applied++;
    }
  }
  // Drop accounts no longer followed (keep file small)
  const followingIds = new Set((loadCache()?.following ?? []).map((u) => String(u.id)));
  let pruned = 0;
  for (const id of Object.keys(state.accounts)) {
    if (followingIds.size && !followingIds.has(id)) { delete state.accounts[id]; pruned++; }
  }
  saveActivityState(state);
  console.log(JSON.stringify({ applied, pruned, files: files.length, path: ACTIVITY_PATH, accounts: Object.keys(state.accounts).length }));
}

if (argv.includes("--plan")) {
  const limit = Number(opt("--limit") ?? icfg.checksPerDay);
  const queue = checkQueue(Number.isFinite(limit) && limit > 0 ? limit : icfg.checksPerDay);
  const batches = [];
  for (let i = 0; i < queue.length; i += LOOKUP_BATCH) {
    batches.push(queue.slice(i, i + LOOKUP_BATCH).map((r) => r.username).join(","));
  }
  const nonMutual = queue.filter((r) => !r.mutual).length;
  console.log(JSON.stringify({
    rule: `inactive if no post/reply (most_recent any-kind) within ${icfg.windowHours}h`,
    windowHours: icfg.windowHours,
    checksPerDay: icfg.checksPerDay,
    minFollowAgeHours: icfg.minFollowAgeHours,
    staleHours: icfg.staleHours,
    planned: queue.length,
    nonMutual,
    mutual: queue.length - nonMutual,
    freeReads: batches.length,
    lookup: {
      tool: "x.get_users_by_usernames",
      params: {
        "user.fields": "most_recent_tweet_id",
        expansions: "most_recent_tweet_id",
        "post.fields": "created_at,referenced_tweets,in_reply_to_user_id",
      },
      batchSize: LOOKUP_BATCH,
      batches,
    },
    then: "for each batch: CallDynamicTool x.get_users_by_usernames → --save lookup <file> → --apply → --report",
  }, null, 2));
}

if (argv.includes("--report") || argv.includes("--apply")) {
  const state = loadActivityState();
  const now = Date.now();
  const tally = { active: 0, inactive: 0, stale: 0, unchecked: 0 };
  // Only count currently-followed accounts
  const following = loadCache()?.following ?? [];
  const followed = new Map(following.map((u) => [String(u.id), u]));
  const followers = followerIdSet(loadCache());
  let inactiveNonMutual = 0;
  let inactiveMutual = 0;
  for (const [id, u] of followed) {
    const row = state.accounts[id];
    const st = inactiveStatus(row, cfg, now);
    tally[st.state] = (tally[st.state] ?? 0) + 1;
    if (st.state === "inactive") {
      if (followers.has(id)) inactiveMutual++;
      else inactiveNonMutual++;
    }
  }
  // accounts in state but we already tallied followed; unchecked = followed without row
  tally.unchecked = [...followed.keys()].filter((id) => !state.accounts[id]).length;
  // recount properly
  const tally2 = { active: 0, inactive: 0, stale: 0, unchecked: 0 };
  inactiveNonMutual = 0; inactiveMutual = 0;
  for (const [id] of followed) {
    const st = inactiveStatus(state.accounts[id], cfg, now);
    tally2[st.state]++;
    if (st.state === "inactive") {
      if (followers.has(id)) inactiveMutual++; else inactiveNonMutual++;
    }
  }
  console.log(JSON.stringify({
    windowHours: icfg.windowHours,
    staleHours: icfg.staleHours,
    following: followed.size,
    stateAccounts: Object.keys(state.accounts).length,
    ...tally2,
    inactiveNonMutual,
    inactiveMutual,
    inactiveInUnfollowPool: inactiveNonMutual, // mutuals excluded by classify
    freeReadsPerDayAtCap: Math.ceil(icfg.checksPerDay / LOOKUP_BATCH),
    updated: state.updated,
  }, null, 2));
}
