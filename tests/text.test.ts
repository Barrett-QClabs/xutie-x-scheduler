import { describe, expect, it } from "vitest";
import { TIMELINE_CACHE_TTL_MS } from "@/lib/constants";
import { buildAuthorizationHeader } from "@/lib/oauth";
import { parseImport } from "@/lib/parse-import";
import { assertSchedule, computeSchedule, pushChain, randomExtraMs } from "@/lib/schedule";
import { shouldReuseTimelineCache } from "@/lib/timeline";
import { inspectTweet, weightedLength } from "@/lib/weighted-length";

describe("weighted length", () => {
  it("counts latin as 1 and CJK as 2", () => {
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("你好")).toBe(4);
    expect(inspectTweet("中".repeat(140)).valid).toBe(true);
    expect(inspectTweet("中".repeat(140)).weightedLength).toBe(280);
    expect(inspectTweet("中".repeat(141)).valid).toBe(true);
    expect(inspectTweet("中".repeat(141)).isLong).toBe(true);
    expect(inspectTweet("中".repeat(140)).isLong).toBe(false);
    expect(inspectTweet("中".repeat(12_500)).valid).toBe(true);
    expect(inspectTweet("中".repeat(12_501)).reason).toBe("too_long");
    expect(inspectTweet("中".repeat(141)).weightedLength).toBe(282);
  });

  it("counts every http(s) URL as 23 and keeps trailing punctuation", () => {
    expect(weightedLength("https://example.com/this-is-a-very-long-url")).toBe(23);
    expect(weightedLength("http://a.co")).toBe(23);
    expect(weightedLength("hi https://a.co")).toBe(26);
    expect(weightedLength("see https://example.com.")).toBe(28);
    expect(weightedLength("你好https://a.co")).toBe(27);
  });

  it("rejects empty text and accepts a simple emoji as short", () => {
    expect(inspectTweet("   ").reason).toBe("empty");
    expect(weightedLength("😀")).toBe(2);
    expect(inspectTweet("a".repeat(280)).valid).toBe(true);
    expect(inspectTweet("a".repeat(281)).valid).toBe(true);
    expect(inspectTweet("a".repeat(25_000)).valid).toBe(true);
    expect(inspectTweet("a".repeat(25_001)).reason).toBe("too_long");
  });
});

describe("import parsing", () => {
  it("splits one post per line when there is no blank line", () => {
    expect(parseImport("一\n二\n三", "text")).toEqual({ tweets: ["一", "二", "三"], mode: "lines" });
  });

  it("splits paragraphs on blank lines and keeps newlines inside a post", () => {
    const parsed = parseImport("第一行\n第二行\n\n第三段\n有两行", "text");
    expect(parsed.mode).toBe("paragraphs");
    expect(parsed.tweets).toEqual(["第一行\n第二行", "第三段\n有两行"]);
  });

  it("splits on a line that is only ---", () => {
    const parsed = parseImport("第一段\n跨行\n\n---\n第二条", "text");
    expect(parsed.mode).toBe("separator");
    expect(parsed.tweets).toEqual(["第一段\n跨行", "第二条"]);
  });

  it("reads a named CSV column and quoted commas", () => {
    const parsed = parseImport('note,内容\nx,"你好,世界"\ny,第二条', "csv");
    expect(parsed).toEqual({ tweets: ["你好,世界", "第二条"], mode: "csv" });
  });

  it("uses the first CSV column when there is no header", () => {
    expect(parseImport("hello,world\nsecond,x", "csv").tweets).toEqual(["hello", "second"]);
  });
});

describe("schedule", () => {
  const pace = { intervalMinutes: 15, randomMinSeconds: 60, randomMaxSeconds: 120 };

  it("spaces posts by exactly the interval when the random range is zero", () => {
    const start = new Date("2026-10-18T01:00:00.000Z");
    const times = computeSchedule({ count: 3, startAt: start, intervalMinutes: 15, randomMinSeconds: 0, randomMaxSeconds: 0 });
    expect(times[0].getTime()).toBe(start.getTime());
    expect(times[1].getTime() - times[0].getTime()).toBe(15 * 60_000);
    expect(times[2].getTime() - times[1].getTime()).toBe(15 * 60_000);
  });

  it("keeps every gap within [interval + min, interval + max], cumulatively from startAt", () => {
    const start = new Date("2026-10-18T08:00:00.000Z");
    const times = computeSchedule({ count: 500, startAt: start, ...pace });
    expect(times[0].getTime()).toBe(start.getTime());
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index].getTime() - times[index - 1].getTime();
      expect(gap).toBeGreaterThanOrEqual(16 * 60_000);
      expect(gap).toBeLessThanOrEqual(17 * 60_000);
      expect(gap).toBeGreaterThanOrEqual(15 * 60_000);
    }
  });

  it("randomizes to the second, not to the minute", () => {
    const start = new Date("2026-10-18T08:00:00.000Z");
    const times = computeSchedule({ count: 200, startAt: start, ...pace });
    const gaps = times.slice(1).map((time, index) => time.getTime() - times[index].getTime());
    expect(gaps.every((gap) => gap % 1000 === 0)).toBe(true);
    const extraSeconds = new Set(gaps.map((gap) => (gap - 15 * 60_000) / 1000));
    expect(extraSeconds.size).toBeGreaterThan(30);
    expect([...extraSeconds].some((value) => value % 60 !== 0)).toBe(true);
    expect(times.every((time) => time.getUTCMilliseconds() === 0)).toBe(true);
  });

  it("maps random() onto whole seconds from min to max inclusive", () => {
    expect(randomExtraMs(pace, () => 0)).toBe(60_000);
    expect(randomExtraMs(pace, () => 0.5)).toBe(90_000);
    expect(randomExtraMs(pace, () => 0.999_999)).toBe(120_000);
    expect(randomExtraMs(pace, () => 1)).toBe(120_000);
    const values = [0, 0.999_999];
    let index = 0;
    const times = computeSchedule({
      count: 3,
      startAt: new Date("2026-10-18T08:00:00.000Z"),
      ...pace,
      random: () => values[index++],
    });
    expect(times.map((time) => time.toISOString())).toEqual([
      "2026-10-18T08:00:00.000Z",
      "2026-10-18T08:16:00.000Z",
      "2026-10-18T08:33:00.000Z",
    ]);
  });

  it("validates 0 <= min <= max < interval in whole seconds", () => {
    expect(() => assertSchedule(15, 60, 120)).not.toThrow();
    expect(() => assertSchedule(15, 0, 0)).not.toThrow();
    expect(() => assertSchedule(15, 120, 60)).toThrow(/随机延迟/);
    expect(() => assertSchedule(15, -1, 60)).toThrow(/随机延迟/);
    expect(() => assertSchedule(15, 60, 900)).toThrow(/随机延迟/);
    expect(() => assertSchedule(15, 1.5, 60)).toThrow(/随机延迟/);
    expect(() => assertSchedule(1.5, 0, 10)).toThrow(/间隔/);
  });

  it("pushes a chain later with random gaps but never moves a post earlier", () => {
    const base = new Date("2026-10-18T08:00:00.000Z").getTime();
    const originals = [base, base + 60_000, base + 5 * 60 * 60_000].map((ms) => new Date(ms));
    const times = pushChain({ originals, firstMinAt: new Date(base + 10 * 60_000 + 400), pace });
    expect(times[0].getTime()).toBe(base + 10 * 60_000 + 1000);
    const gap = times[1].getTime() - times[0].getTime();
    expect(gap).toBeGreaterThanOrEqual(16 * 60_000);
    expect(gap).toBeLessThanOrEqual(17 * 60_000);
    expect(times[2].getTime()).toBe(originals[2].getTime());
  });
});

describe("oauth 1.0a", () => {
  it("matches the documented Twitter signature example", () => {
    // Public values from Twitter's published OAuth 1.0a signature example.
    // They are documentation fixtures, not live credentials.
    const { signature, header } = buildAuthorizationHeader({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json",
      credentials: {
        apiKey: "xvz1evFS4wEEPTGEFPHBog",
        apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      extraParams: {
        include_entities: "true",
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    });
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});

describe("timeline cache", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const intervalMs = 15 * 60_000;

  it("reuses only a fresh check (TTL), so manual posts made right after ours are seen promptly", () => {
    expect(
      shouldReuseTimelineCache({
        checkedAt: new Date(now.getTime() - 30_000).toISOString(),
        latestAt: null,
        ok: false,
        now,
        intervalMs,
        ttlMs: TIMELINE_CACHE_TTL_MS,
      }),
    ).toBe(true);

    expect(
      shouldReuseTimelineCache({
        checkedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
        latestAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        ok: true,
        now,
        intervalMs,
        ttlMs: TIMELINE_CACHE_TTL_MS,
      }),
    ).toBe(false);

    expect(
      shouldReuseTimelineCache({
        checkedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
        latestAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
        ok: true,
        now,
        intervalMs,
        ttlMs: TIMELINE_CACHE_TTL_MS,
      }),
    ).toBe(false);

    expect(
      shouldReuseTimelineCache({
        checkedAt: null,
        latestAt: null,
        ok: false,
        now,
        intervalMs,
        ttlMs: TIMELINE_CACHE_TTL_MS,
      }),
    ).toBe(false);
  });
});
