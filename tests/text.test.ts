import { describe, expect, it } from "vitest";
import { TIMELINE_CACHE_TTL_MS } from "@/lib/constants";
import { buildAuthorizationHeader } from "@/lib/oauth";
import { parseImport } from "@/lib/parse-import";
import { computeSchedule } from "@/lib/schedule";
import { shouldReuseTimelineCache } from "@/lib/timeline";
import { inspectTweet, weightedLength } from "@/lib/weighted-length";

describe("weighted length", () => {
  it("counts latin as 1 and CJK as 2", () => {
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("你好")).toBe(4);
    expect(inspectTweet("中".repeat(140)).valid).toBe(true);
    expect(inspectTweet("中".repeat(140)).weightedLength).toBe(280);
    expect(inspectTweet("中".repeat(141)).valid).toBe(false);
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
    expect(inspectTweet("a".repeat(281)).reason).toBe("too_long");
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
  it("spaces posts by the interval when jitter is zero", () => {
    const start = new Date("2026-10-18T01:00:00.000Z");
    const times = computeSchedule({ count: 3, startAt: start, intervalMinutes: 15, jitterMinutes: 0 });
    expect(times[1].getTime() - times[0].getTime()).toBe(15 * 60_000);
    expect(times[2].getTime() - times[1].getTime()).toBe(15 * 60_000);
  });

  it("applies jitter and never lets two posts overlap", () => {
    const start = new Date("2026-10-18T01:00:00.000Z");
    const values = [1, 0];
    let index = 0;
    const times = computeSchedule({
      count: 2,
      startAt: start,
      intervalMinutes: 15,
      jitterMinutes: 14,
      random: () => values[index++],
    });
    expect(times[0].getTime()).toBe(start.getTime() + 14 * 60_000);
    expect(times[1].getTime()).toBe(times[0].getTime() + 15_000);
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

  it("reuses a fresh check, and a successful check until the interval has elapsed", () => {
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
    ).toBe(true);

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
