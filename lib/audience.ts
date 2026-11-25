import type { Audience } from "@/lib/automation-account";

const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu;
const KANA_RE = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/gu;

/** Obvious scam or spam phrases. A match skips that one candidate. */
const SCAM_RE =
  /\b(?:dm me|send btc|double your|seed phrase|wallet connect|airdrop|giveaway)\b|投资返利|稳赚不赔|带单|杀猪盘|刷单|兼职日结/i;

function clean(value: string | null): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ");
}

function cjkStats(value: string | null): { han: number; kana: number } {
  const text = clean(value);
  return { han: text.match(HAN_RE)?.length ?? 0, kana: text.match(KANA_RE)?.length ?? 0 };
}

function isChineseText(value: string | null, minHan: number): boolean {
  const stats = cjkStats(value);
  return stats.han >= minHan && stats.kana * 2 < stats.han;
}

export function spamText(parts: Array<string | null>): boolean {
  return parts.some((part) => SCAM_RE.test(clean(part)));
}

export function preferFlb(parts: Array<string | null>): boolean {
  return parts.some((part) => /\bflb\b|follow\s*backs?|回关|互关/i.test(clean(part)));
}

/**
 * New-follow audience only. Follow-back does not use this.
 * Missing tweet language stays unknown and does not count as a match.
 */
export function audienceMatch(
  audience: Audience,
  profile: { tweetLang: string | null; name: string | null; bio: string | null; tweetText: string | null },
): "match" | "miss" | "unknown" {
  if (!profile.tweetLang) return "unknown";
  if (audience === "en") return profile.tweetLang === "en" ? "match" : "miss";
  if (profile.tweetLang !== "zh") return "miss";
  if (isChineseText(profile.name, 2) || isChineseText(profile.bio, 2)) return "match";
  const name = cjkStats(profile.name);
  const bio = cjkStats(profile.bio);
  if (name.han + bio.han + name.kana + bio.kana > 0) return "miss";
  return isChineseText(profile.tweetText, 4) ? "match" : "miss";
}
