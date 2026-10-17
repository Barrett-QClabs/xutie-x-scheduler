/**
 * Weighted length close to twitter-text config v3:
 * most Latin characters count as 1, CJK and emoji count as 2,
 * and each http(s) URL counts as 23 regardless of its real length.
 * Variation selectors, ZWJ, and skin tones add nothing so a single
 * emoji stays near 2. Flag sequences can still be slightly high.
 */
export const MAX_WEIGHTED_LENGTH = 280;
const SCALE = 100;
const URL_WEIGHT = 23;

const RANGES: Array<[number, number, number]> = [
  [0, 4351, 100],
  [8192, 8205, 100],
  [8208, 8223, 100],
  [8242, 8247, 100],
];

function codePointWeight(codePoint: number): number {
  if (
    codePoint === 0x200d ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  ) {
    return 0;
  }
  for (const [start, end, weight] of RANGES) {
    if (codePoint >= start && codePoint <= end) return weight;
  }
  return 200;
}

function findUrls(text: string): Array<{ start: number; end: number }> {
  const urls: Array<{ start: number; end: number }> = [];
  const pattern = /https?:\/\/[^\s]+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = match[0].replace(/[.,!?;:'"\]\)\}>]+$/g, "");
    if (raw.length <= "https://".length) continue;
    urls.push({ start: match.index, end: match.index + raw.length });
  }
  return urls;
}

export function weightedLength(text: string): number {
  const urls = findUrls(text);
  let weight = 0;
  let index = 0;
  while (index < text.length) {
    const url = urls.find((item) => item.start === index);
    if (url) {
      weight += URL_WEIGHT * SCALE;
      index = url.end;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const insideUrl = urls.some((item) => index > item.start && index < item.end);
    if (!insideUrl) weight += codePointWeight(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return Math.floor(weight / SCALE);
}

export function inspectTweet(text: string): {
  text: string;
  weightedLength: number;
  valid: boolean;
  reason?: "empty" | "too_long";
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", weightedLength: 0, valid: false, reason: "empty" };
  }
  const length = weightedLength(trimmed);
  if (length > MAX_WEIGHTED_LENGTH) {
    return { text: trimmed, weightedLength: length, valid: false, reason: "too_long" };
  }
  return { text: trimmed, weightedLength: length, valid: true };
}
