#!/usr/bin/env node
/**
 * Build / merge keyword-candidates/YYYY-MM-DD.json from free X plugin search pages.
 *
 * Usage:
 *   node write-keyword-pool.mjs [--merge] [--day YYYY-MM-DD] [page.json ...]
 *
 * Without page args: reads all $X_AUTOMATION_DIR/plugin-pages/keyword/search-*.json
 * (default /workspace/x-unfollow/plugin-pages/keyword).
 *
 * Each page is a search_posts_all (or similar) response with data[] posts and
 * includes.users[] authors (expansions=author_id). Filename should encode
 * category + keyword, e.g. search-AI-人工智能-p001.json or search-商业-创业-p002.json
 * (category is the first path segment after "search-").
 *
 * Filters (every candidate must pass):
 *   blue verified, followers_count ≤ maxFollowers (config, default 100),
 *   not protected, chineseZoneCheck, not excluded (following / logs / whitelist),
 *   not already in prior pools as followed/tried.
 *
 * Writes keyword-candidates/<Asia/Shanghai date>.json in the shape keywordfollow.mjs expects.
 * --merge: keep existing today's candidates and union by id (new entries win fields).
 *
 * Hourly top-up: save new plugin search pages, then
 *   node write-keyword-pool.mjs --merge
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chineseZoneCheck, DATA_DIR, POOL_DIR, KW_LOG, FB_LOG, loadConfig, readJsonl, readJson } from "./follow-common.mjs";
import { dayKey, loadAlreadyUnfollowedIds, isBlueV, loadCache } from "./unfollow.mjs";

const PAGES_DIR = path.join(DATA_DIR, "plugin-pages", "keyword");
const merge = process.argv.includes("--merge");
const dayArgIdx = process.argv.indexOf("--day");
const day = dayArgIdx >= 0 ? process.argv[dayArgIdx + 1] : dayKey(new Date());
const args = process.argv.slice(2).filter((a, i, arr) => {
  if (a === "--merge") return false;
  if (a === "--day") return false;
  if (dayArgIdx >= 0 && i === dayArgIdx - 2 + 2 /* relative */) return false;
  if (arr[i - 1] === "--day") return false;
  return true;
});

const CATEGORY_KEYWORDS = {
  AI: ["AI", "人工智能", "ChatGPT", "大模型", "AIGC", "Claude", "Midjourney", "提示词", "GPT"],
  商业: ["商业", "创业", "赚钱", "副业", "投资", "电商", "引流", "私域", "搞钱", "盈利"],
  两性: ["两性", "恋爱", "婚姻", "情感", "男女", "约会", "脱单", "相亲", "恋爱脑", "婚姻观"],
};

function categoryOfKeyword(kw) {
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((k) => k.toLowerCase() === String(kw).toLowerCase()) || cat === kw) return cat;
  }
  // filename / free-form fallbacks
  const s = String(kw);
  if (/AI|人工|ChatGPT|大模型|AIGC|Claude|GPT|提示/i.test(s)) return "AI";
  if (/商业|创业|赚钱|副业|投资|电商|引流|私域|搞钱|盈利|crypto|币圈/i.test(s)) return "商业";
  if (/两性|恋爱|婚姻|情感|男女|约会|脱单|相亲|dating/i.test(s)) return "两性";
  return null;
}

/** Parse category + keyword from filename: search-<cat>-<kw>-pNNN.json */
function metaFromFilename(file) {
  const base = path.basename(file).replace(/\.json$/i, "");
  const m = base.match(/^search-(AI|商业|两性)-(.+)-p\d+$/i);
  if (m) return { category: m[1] === "AI" || m[1] === "ai" ? "AI" : m[1], keyword: m[2] };
  const m2 = base.match(/^search-(.+)-p\d+$/i);
  if (m2) {
    const parts = m2[1].split("-");
    const cat = categoryOfKeyword(parts[0]) ?? categoryOfKeyword(parts.slice(0, 2).join("-"));
    return { category: cat, keyword: parts[parts.length - 1] || parts[0] };
  }
  return { category: null, keyword: null };
}

function loadPage(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // Accept raw API shape or {response: {...}} wrappers
  const body = raw?.data && (raw.includes || raw.meta) ? raw
    : raw?.response?.data ? raw.response
    : raw;
  const posts = Array.isArray(body?.data) ? body.data : [];
  const users = new Map();
  for (const u of body?.includes?.users ?? []) if (u?.id) users.set(String(u.id), u);
  return { posts, users, meta: body?.meta ?? {} };
}

function globPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs.readdirSync(PAGES_DIR)
    .filter((f) => /^search-.*\.json$/i.test(f))
    .sort()
    .map((f) => path.join(PAGES_DIR, f));
}

function loadWhitelist() {
  const p = path.join(DATA_DIR, "whitelist.txt");
  if (!fs.existsSync(p)) return new Set();
  return new Set(fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim().replace(/^@/, "").toLowerCase()).filter((l) => l && !l.startsWith("#")));
}

function excludedIds(meId) {
  const s = new Set([String(meId || "1933586991612080128")]);
  for (const u of loadCache()?.following ?? []) if (u?.id) s.add(String(u.id));
  for (const id of loadAlreadyUnfollowedIds()) s.add(String(id));
  for (const e of readJsonl(FB_LOG)) if (e.id && (e.result === "ok" || e.pending)) s.add(String(e.id));
  for (const e of readJsonl(KW_LOG)) if (e.id && (e.result === "ok" || e.pending)) s.add(String(e.id));
  // also skip previously skipped-as-bad from keyword log (already following etc. less critical)
  return s;
}

function isBlue(u) {
  if (u.verified === true) return true;
  const vt = (u.verified_type ?? "").toLowerCase();
  if (vt && vt !== "none") return true;
  return isBlueV(u);
}

const files = args.length ? args : globPages();
if (!files.length) {
  console.error("No page files. Pass plugin JSON paths or put them in", PAGES_DIR);
  process.exit(1);
}

const cfg = loadConfig().keywordfollow;
const maxFollowers = cfg.maxFollowers ?? 100;
const poolSize = cfg.poolSize ?? 250;
const me = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "me-cache.json"), "utf8")); } catch { return { id: "1933586991612080128", username: "barrett_tt" }; }
})();
const exclude = excludedIds(me.id);
const whitelist = loadWhitelist();
const outPath = path.join(POOL_DIR, `${day}.json`);
fs.mkdirSync(POOL_DIR, { recursive: true });

const candidates = new Map();
const perKeyword = {};
const perCategory = { AI: 0, 商业: 0, 两性: 0 };
const rejected = { notVerified: 0, tooManyFollowers: 0, protected: 0, excluded: 0, notChinese: 0, noCategory: 0, whitelist: 0, noUser: 0 };
let postsRead = 0, pages = 0;

if (merge && fs.existsSync(outPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
    for (const c of prev?.candidates ?? []) {
      if (!c?.id) continue;
      if (exclude.has(String(c.id))) continue;
      if (c.zh_ok !== true) continue;
      if ((c.followers_count ?? Infinity) > maxFollowers) continue;
      candidates.set(String(c.id), c);
      const cat = c.category || categoryOfKeyword(c.keyword);
      if (cat && perCategory[cat] != null) perCategory[cat] += 1;
      if (c.keyword) {
        perKeyword[c.keyword] = perKeyword[c.keyword] || { pages: 0, posts: 0, added: 0 };
        perKeyword[c.keyword].added += 1;
      }
    }
  } catch (err) {
    console.error("warn: could not read existing pool:", err.message);
  }
}

for (const file of files) {
  let page;
  try { page = loadPage(file); } catch (err) {
    console.error("skip", file, err.message); continue;
  }
  pages += 1;
  const fileMeta = metaFromFilename(file);
  postsRead += page.posts.length;
  const kwKey = fileMeta.keyword || "unknown";
  perKeyword[kwKey] = perKeyword[kwKey] || { pages: 0, posts: 0, added: 0 };
  perKeyword[kwKey].pages += 1;
  perKeyword[kwKey].posts += page.posts.length;

  const seenAuthor = new Set();
  for (const t of page.posts) {
    const aid = String(t.author_id ?? "");
    if (!aid || seenAuthor.has(aid)) continue;
    seenAuthor.add(aid);
    if (candidates.has(aid)) continue;
    if (exclude.has(aid)) { rejected.excluded++; continue; }
    if (t.lang && t.lang !== "zh") { rejected.notChinese++; continue; }
    const u = page.users.get(aid);
    if (!u) { rejected.noUser++; continue; }
    if (!isBlue(u)) { rejected.notVerified++; continue; }
    const followers = u.public_metrics?.followers_count ?? Infinity;
    if (followers > maxFollowers) { rejected.tooManyFollowers++; continue; }
    if (u.protected) { rejected.protected++; continue; }
    if ((u.username ?? "").toLowerCase() === (me.username ?? "").toLowerCase()) { rejected.excluded++; continue; }
    if (whitelist.has((u.username ?? "").toLowerCase())) { rejected.whitelist++; continue; }
    const zh = chineseZoneCheck({ tweetLang: t.lang, name: u.name, bio: u.description, tweetText: t.text });
    if (!zh.ok) { rejected.notChinese++; continue; }
    const keyword = fileMeta.keyword || kwKey;
    const category = fileMeta.category || categoryOfKeyword(keyword);
    if (!category) { rejected.noCategory++; continue; }
    const entry = {
      id: aid,
      username: u.username,
      name: u.name,
      followers_count: followers,
      verified: u.verified === true,
      verified_type: u.verified_type ?? (u.verified ? "blue" : null),
      keyword,
      category,
      tweet_id: t.id,
      tweet_at: t.created_at,
      tweet_lang: t.lang ?? null,
      bio: (u.description ?? "").replace(/\s+/g, " ").slice(0, 160),
      text: (t.text ?? "").replace(/\s+/g, " ").slice(0, 200),
      zh_ok: true,
      zh_why: zh.why,
      source: "free-plugin-search",
    };
    candidates.set(aid, entry);
    exclude.add(aid);
    perKeyword[kwKey].added += 1;
    perCategory[category] = (perCategory[category] ?? 0) + 1;
  }
}

const list = [...candidates.values()];
// Prefer even spread hint: sort by category then followers ascending (smaller accounts first)
const catOrder = { AI: 0, 商业: 1, 两性: 2 };
list.sort((a, b) => (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9) || (a.followers_count - b.followers_count));
const trimmed = list.slice(0, Math.max(poolSize, list.length)); // keep all found; daemon caps follows
const pool = {
  date: day,
  built: new Date().toISOString(),
  source: "free-x-plugin search_posts_all (NO_PAID_READS pool)",
  keywords: cfg.keywords,
  categories: ["AI", "商业", "两性"],
  target: poolSize,
  count: trimmed.length,
  searchPages: pages,
  postsRead,
  perKeyword,
  perCategory: trimmed.reduce((acc, c) => { acc[c.category] = (acc[c.category] ?? 0) + 1; return acc; }, { AI: 0, 商业: 0, 两性: 0 }),
  rejected,
  filters: {
    verified: "verified==true or verified_type!=none",
    maxFollowers,
    protected: false,
    notFollowing: true,
    notPreviouslyFollowedOrUnfollowed: true,
    chineseZone: "tweet lang zh AND (Chinese name/bio; tweet fallback)",
    query: "<kw> lang:zh is:verified -is:retweet",
    categories: ["AI", "商业", "两性"],
  },
  candidates: trimmed,
  droppedNonChinese: [],
};

fs.writeFileSync(outPath, JSON.stringify(pool, null, 2));
console.log(JSON.stringify({
  ok: true, out: outPath, files: files.length, pages, postsRead,
  count: pool.count, target: poolSize, maxFollowers,
  perCategory: pool.perCategory, rejected, merge, day,
  sample: trimmed.slice(0, 8).map((c) => `@${c.username} ${c.followers_count} [${c.category}/${c.keyword}]`),
}, null, 2));
