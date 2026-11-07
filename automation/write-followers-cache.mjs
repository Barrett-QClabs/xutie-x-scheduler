#!/usr/bin/env node
/**
 * Build followers-free-cache.json from FREE user-X plugin pages (get_users_me_followers,
 * max_results=1000, user.fields=username,verified,verified_type,connection_status), paged
 * via meta.next_token until absent. unfollow.mjs uses this file for the tier-3 follow-back
 * re-check instead of the paid GET /2/users.
 *
 * Usage: node write-followers-cache.mjs page1.json page2.json ... (ALL pages, in order)
 *   The last page must have no meta.next_token, otherwise the cache is marked complete:false
 *   (unfollow treats incomplete caches as missing → skips tier-3 blue-V candidates).
 * Unknown flags are rejected (exit 2) and nothing is written.
 */
import fs from "node:fs";
import path from "node:path";
const DATA_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
const OUT = path.join(DATA_DIR, "followers-free-cache.json");
const args = process.argv.slice(2);
const bad = args.filter((a) => a.startsWith("-"));
if (bad.length || !args.length) {
  console.error(`usage: node write-followers-cache.mjs page1.json ... (unknown/missing: ${bad.join(" ") || "no files"}); nothing written`);
  process.exit(2);
}
const ids = new Set(); let complete = false; let pages = 0; let mutual = 0;
for (const f of args) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const data = Array.isArray(j) ? j : (j.data ?? []);
  for (const u of data) { if (!u?.id) continue; ids.add(String(u.id)); if ((u.connection_status ?? []).includes("following")) mutual++; }
  pages++; complete = !(j?.meta?.next_token);
}
const out = { fetchedAt: new Date().toISOString(), source: "user-X get_users_me_followers (free)", complete, pages, count: ids.size, ids: [...ids] };
const tmp = OUT + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, OUT);
console.log(JSON.stringify({ ok: true, out: OUT, complete, pages, followers: ids.size, mutualSeen: mutual }, null, 2));
