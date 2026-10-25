#!/usr/bin/env node
/**
 * Build / merge followback-targets.json from free X plugin follower page files.
 *
 * Usage:
 *   node write-followback-targets.mjs [--merge] [page.json ...]
 *
 * Without args: reads all $X_AUTOMATION_DIR/plugin-pages/followers-page-*.json
 * (default /workspace/x-unfollow/plugin-pages).
 *
 * Keeps users where connection_status includes "followed_by" but NOT "following"
 * and NOT "follow_request_sent", and verified (verified===true or verified_type not none).
 * Writes /workspace/x-unfollow/followback-targets.json as
 *   [{id, username, verified_type, verified, protected, fetchedAt}, ...]
 * oldest-waiting first (plugin pages are newest-first; we reverse).
 *
 * --merge: union with existing file by id (entries from this run win).
 * Hourly refresh: save newest 1–3 plugin pages and
 *   node write-followback-targets.mjs --merge newest1.json newest2.json
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
const OUT = path.join(DATA_DIR, "followback-targets.json");
const PAGES_DIR = path.join(DATA_DIR, "plugin-pages");
const merge = process.argv.includes("--merge");
const args = process.argv.slice(2).filter((a) => a !== "--merge");

function isBlue(u) {
  const vt = (u.verified_type ?? "").toLowerCase();
  if (u.verified === true) return true;
  if (vt && vt !== "none") return true;
  return false;
}

function needsFollowBack(u) {
  const cs = u.connection_status ?? [];
  return cs.includes("followed_by") && !cs.includes("following") && !cs.includes("follow_request_sent");
}

function loadPage(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
}

function globPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs.readdirSync(PAGES_DIR)
    .filter((f) => /^followers-page-.*\.json$/i.test(f))
    .sort()
    .map((f) => path.join(PAGES_DIR, f));
}

const files = args.length ? args : globPages();
if (!files.length) {
  console.error("No page files. Pass plugin JSON paths or put them in", PAGES_DIR);
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
const byId = new Map();
const order = []; // first-seen order across files (page1 newest ... last page oldest)

if (merge && fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const list = Array.isArray(prev) ? prev : (prev.targets ?? []);
    for (const t of list) if (t?.id) byId.set(String(t.id), t);
  } catch (err) {
    console.error("warn: could not read existing targets:", err.message);
  }
}

let scanned = 0, blueNonMutual = 0, mutual = 0, nonBlue = 0, pending = 0, other = 0;
for (const file of files) {
  let users;
  try { users = loadPage(file); } catch (err) {
    console.error("skip", file, err.message); continue;
  }
  for (const u of users) {
    if (!u?.id) continue;
    scanned += 1;
    const cs = u.connection_status ?? [];
    if (cs.includes("follow_request_sent") && cs.includes("followed_by") && !cs.includes("following")) {
      pending += 1; continue;
    }
    if (cs.includes("following") && cs.includes("followed_by")) { mutual += 1; continue; }
    if (!needsFollowBack(u)) { other += 1; continue; }
    if (!isBlue(u)) { nonBlue += 1; continue; }
    blueNonMutual += 1;
    const id = String(u.id);
    const entry = {
      id,
      username: u.username ?? "",
      verified_type: u.verified_type ?? (u.verified ? "blue" : "none"),
      verified: u.verified === true,
      protected: !!u.protected,
      fetchedAt,
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, entry);
  }
}

// Plugin pages are newest-first; reverse so oldest-waiting are followed first.
const ids = merge
  ? [...new Set([...order, ...byId.keys()])] // new ids first in order, then prior
  : order;
const targets = ids.map((id) => byId.get(id)).filter(Boolean).reverse();

fs.writeFileSync(OUT, JSON.stringify(targets, null, 2));
console.log(JSON.stringify({
  ok: true, out: OUT, files: files.length, scanned, mutual,
  pendingFollowRequest: pending, nonBlueFollowBack: nonBlue, otherSkipped: other,
  blueVFollowBackTargets: targets.length, merge, fetchedAt,
}, null, 2));
