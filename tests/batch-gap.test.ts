import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BATCH } from "@/lib/constants";
import { getTimelineCache, patchTweet, setTimelineCache, updateAccount } from "@/lib/db";
import { getPublicState, importTweets, saveCredentials } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import { createLiveXClient, type XClient } from "@/lib/x-client";

const secret = "super-secret-value-xyz";
const user = { id: "42", username: "demo", name: "Demo" };

function connect() {
  saveCredentials({
    apiKey: "abc12345",
    apiSecret: secret,
    accessToken: "token-value",
    accessTokenSecret: "token-secret-value",
  });
  updateAccount({ username: user.username, displayName: user.name, userId: user.id });
}

function queue(source: string, startAt: string) {
  return importTweets({
    source,
    format: "text",
    startAt,
    intervalMinutes: 15,
  });
}

/** random() = 0.5 picks 60 + floor(0.5 * 61) = 90 extra seconds. */
const half = () => 0.5;

/** Expected slot: previous post + 15 minutes + extra seconds, rounded up to the second. */
function slot(after: Date, extraSeconds: number): Date {
  return new Date(Math.ceil((after.getTime() + 15 * 60_000 + extraSeconds * 1000) / 1000) * 1000);
}

describe("import batch cap", () => {
  it("accepts only the first 50 valid posts and reports the rest", () => {
    expect(MAX_IMPORT_BATCH).toBe(50);
    const lines = Array.from({ length: 51 }, (_, index) => `帖子${index + 1}`);
    const imported = queue(lines.join("\n"), new Date(Date.now() + 60_000).toISOString());
    expect(imported.queuedCount).toBe(50);
    expect(imported.omittedCount).toBe(1);
    expect(imported.batchLimit).toBe(50);
    expect(imported.invalid).toEqual([]);
    expect(imported.queued[0].text).toBe("帖子1");
    expect(imported.queued[49].text).toBe("帖子50");
    expect(getPublicState().tweets.some((tweet) => tweet.text === "帖子51")).toBe(false);
    for (let index = 1; index < 50; index += 1) {
      const gap =
        new Date(imported.queued[index].scheduledAt).getTime() -
        new Date(imported.queued[index - 1].scheduledAt).getTime();
      expect(gap).toBeGreaterThanOrEqual(16 * 60_000);
      expect(gap).toBeLessThanOrEqual(17 * 60_000);
    }
  });

  it("does not count over-limit lines toward the batch of 50", () => {
    const valid = Array.from({ length: 50 }, (_, index) => `好${index + 1}`);
    const imported = queue([...valid, "中".repeat(12_501)].join("\n"), new Date(Date.now() + 60_000).toISOString());
    expect(imported.queuedCount).toBe(50);
    expect(imported.omittedCount).toBe(0);
    expect(imported.invalid).toHaveLength(1);
    expect(imported.invalid[0].reason).toBe("too_long");
  });
});

describe("recent posts on X", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers the queue when a manual post is inside the interval, and caches the read", async () => {
    connect();
    const now = new Date();
    const latestAt = new Date(now.getTime() - 5 * 60_000);
    const imported = queue("第一条\n第二条", new Date(now.getTime() + 60 * 60_000).toISOString());
    patchTweet(imported.queued[0].id, { scheduledAt: new Date(now.getTime() - 60_000).toISOString() });
    patchTweet(imported.queued[1].id, { scheduledAt: new Date(now.getTime() + 15 * 60_000).toISOString() });
    const originalGap = 16 * 60_000;

    let reads = 0;
    let posts = 0;
    const client: XClient = {
      verify: async () => user,
      postTweet: async () => {
        posts += 1;
        return { id: "should-not-post" };
      },
      latestTweet: async (userId) => {
        reads += 1;
        expect(userId).toBe("42");
        return { id: "external-1", createdAt: latestAt.toISOString() };
      },
    };

    const deferred = await tick({ now, client, random: half });
    const earliest = slot(latestAt, 90);
    expect(deferred).toEqual({ action: "deferred", until: earliest.toISOString(), manual: true });
    expect(posts).toBe(0);
    expect(reads).toBe(1);

    const shifted = getPublicState().tweets;
    expect(new Date(shifted[0].scheduledAt).toISOString()).toBe(earliest.toISOString());
    expect(new Date(shifted[1].scheduledAt).getTime() - new Date(shifted[0].scheduledAt).getTime()).toBe(
      15 * 60_000 + 90_000,
    );
    expect(originalGap).toBeLessThan(15 * 60_000 + 90_000);
    expect(shifted.every((tweet) => tweet.delayReason === "manual")).toBe(true);

    patchTweet(shifted[0].id, { scheduledAt: now.toISOString() });
    const cached = await tick({ now: new Date(now.getTime() + 1000), client, random: half });
    expect(cached).toMatchObject({ action: "deferred", manual: true });
    expect(reads).toBe(1);
    expect(posts).toBe(0);

    const posted = await tick({
      now: earliest,
      client: {
        ...client,
        postTweet: async () => {
          posts += 1;
          return { id: "after-gap" };
        },
        latestTweet: async () => {
          reads += 1;
          return { id: "external-1", createdAt: latestAt.toISOString() };
        },
      },
    });
    expect(reads).toBe(2);
    expect(posted).toMatchObject({ action: "posted", tweetId: "after-gap" });
    expect(getPublicState().tweets.find((tweet) => tweet.text === "第一条")?.delayReason).toBeNull();
  });

  it("still waits after this tool's own post, without calling that a manual delay", async () => {
    connect();
    const now = new Date();
    const postedAt = new Date(now.getTime() - 5 * 60_000);
    queue("已发出", postedAt.toISOString());
    const posted = await tick({
      now: postedAt,
      client: {
        verify: async () => user,
        postTweet: async () => ({ id: "ours-1" }),
      },
    });
    expect(posted).toMatchObject({ action: "posted", tweetId: "ours-1" });
    setTimelineCache({ checkedAt: null, latestAt: null, latestId: null, ok: false });

    queue("下一条", now.toISOString());
    let reads = 0;
    const deferred = await tick({
      now,
      random: half,
      client: {
        verify: async () => user,
        postTweet: async () => {
          throw new Error("间隔还没到，不应发帖");
        },
        latestTweet: async () => {
          reads += 1;
          return { id: "ours-1", createdAt: postedAt.toISOString() };
        },
      },
    });
    expect(reads).toBe(1);
    expect(deferred).toMatchObject({ action: "deferred", manual: false });
    const next = getPublicState().tweets.find((tweet) => tweet.text === "下一条");
    expect(next?.delayReason).toBeNull();
    expect(next?.status).toBe("pending");
    expect(new Date(next!.scheduledAt).toISOString()).toBe(slot(postedAt, 90).toISOString());
  });

  it("logs a timeline failure, falls back to the local last post, and does not reread within the cache window", async () => {
    connect();
    const now = new Date();
    const postedAt = new Date(now.getTime() - 5 * 60_000);
    queue("已发出", postedAt.toISOString());
    await tick({
      now: postedAt,
      client: {
        verify: async () => user,
        postTweet: async () => ({ id: "ours-1" }),
      },
    });
    setTimelineCache({ checkedAt: null, latestAt: null, latestId: null, ok: false });
    const pending = queue("下一条", now.toISOString()).queued[0];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    const client: XClient = {
      verify: async () => user,
      postTweet: async () => {
        throw new Error("应改用本地上次发送时间，先不发");
      },
      latestTweet: async () => {
        reads += 1;
        throw new Error("timeline down");
      },
    };
    const deferred = await tick({ now, client, random: half });
    expect(deferred).toMatchObject({ action: "deferred", manual: false });
    expect(reads).toBe(1);
    expect(getTimelineCache().ok).toBe(false);
    expect(warn).toHaveBeenCalledWith("[序帖] 读取最近帖子失败，改用本工具自己的上次发送时间。", "timeline down");
    const next = getPublicState().tweets.find((tweet) => tweet.text === "下一条");
    expect(next?.delayReason).toBeNull();
    expect(new Date(next!.scheduledAt).toISOString()).toBe(slot(postedAt, 90).toISOString());

    patchTweet(pending.id, { scheduledAt: new Date(now.getTime() + 5_000).toISOString() });
    const again = await tick({ now: new Date(now.getTime() + 5_000), client });
    expect(again.action).toBe("deferred");
    expect(reads).toBe(1);
  });

  it("posts anyway when the timeline read fails and there is no local post to fall back to", async () => {
    connect();
    const now = new Date();
    queue("第一条", new Date(now.getTime() - 60_000).toISOString());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await tick({
      now,
      client: {
        verify: async () => user,
        latestTweet: async () => {
          throw new Error("timeline down");
        },
        postTweet: async () => ({ id: "posted-1" }),
      },
    });
    expect(result).toMatchObject({ action: "posted", tweetId: "posted-1" });
    expect(warn).toHaveBeenCalledWith("[序帖] 读取最近帖子失败，改用本工具自己的上次发送时间。", "timeline down");
    expect(getTimelineCache().ok).toBe(true);
    expect(getTimelineCache().latestId).toBe("posted-1");
  });
});

describe("random extra delay when the queue shifts", () => {
  function expectRandomGaps(times: number[]) {
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index] - times[index - 1];
      expect(gap).toBeGreaterThanOrEqual(16 * 60_000);
      expect(gap).toBeLessThanOrEqual(17 * 60_000);
    }
  }

  it("after a manual post on X, moves the queue to that post + interval + 1–2 random minutes", async () => {
    connect();
    const now = new Date("2026-10-18T08:00:00.400Z");
    const manualAt = new Date("2026-10-18T07:55:00.000Z");
    const imported = queue("甲\n乙\n丙\n丁", new Date(now.getTime() - 1000).toISOString());
    // Squeeze the batch so every post has to move.
    imported.queued.forEach((tweet, index) => {
      patchTweet(tweet.id, { scheduledAt: new Date(now.getTime() - 1000 + index * 60_000).toISOString() });
    });
    const deferred = await tick({
      now,
      client: {
        verify: async () => user,
        postTweet: async () => {
          throw new Error("不应发帖");
        },
        latestTweet: async () => ({ id: "manual-1", createdAt: manualAt.toISOString() }),
      },
    });
    expect(deferred).toMatchObject({ action: "deferred", manual: true });
    const pending = getPublicState()
      .tweets.filter((tweet) => tweet.status === "pending")
      .map((tweet) => new Date(tweet.scheduledAt).getTime())
      .sort((a, b) => a - b);
    const firstGap = pending[0] - manualAt.getTime();
    expect(firstGap).toBeGreaterThanOrEqual(16 * 60_000);
    expect(firstGap).toBeLessThanOrEqual(17 * 60_000);
    expect(firstGap % 1000).toBe(0);
    expect(new Date((deferred as { until: string }).until).getTime()).toBe(pending[0]);
    expectRandomGaps(pending);
  });

  it("spaces out overdue posts with interval + random extra instead of a fixed interval", async () => {
    connect();
    const now = new Date("2026-10-18T08:00:00.000Z");
    queue("一\n二\n三\n四", new Date(now.getTime() - 3 * 60 * 60_000).toISOString());
    const values = [0, 0.999_999, 0.25];
    let index = 0;
    const result = await tick({
      now,
      random: () => values[index++ % values.length],
      client: { verify: async () => user, postTweet: async () => ({ id: "first-now" }) },
    });
    expect(result).toMatchObject({ action: "posted", tweetId: "first-now" });
    const pending = getPublicState()
      .tweets.filter((tweet) => tweet.status === "pending")
      .map((tweet) => new Date(tweet.scheduledAt).getTime())
      .sort((a, b) => a - b);
    expect(pending).toEqual([
      now.getTime() + 16 * 60_000,
      now.getTime() + 16 * 60_000 + 17 * 60_000,
      now.getTime() + 16 * 60_000 + 17 * 60_000 + 15 * 60_000 + 75_000,
    ]);
  });

  it("reschedules through PUT /api/queue with the random range and ignores legacy jitterMinutes", async () => {
    const { PUT } = await import("@/app/api/queue/route");
    queue(Array.from({ length: 10 }, (_, index) => `重排${index}`).join("\n"), new Date(Date.now() + 60_000).toISOString());
    const startAt = new Date(Date.now() + 10 * 60_000);
    const response = await PUT(
      new Request("http://localhost/api/queue", {
        method: "PUT",
        body: JSON.stringify({
          intervalMinutes: 15,
          jitterMinutes: 5,
          randomMinSeconds: 60,
          randomMaxSeconds: 120,
          reschedule: true,
          startAt: startAt.toISOString(),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const state = getPublicState();
    expect(state.queue).toMatchObject({ intervalMinutes: 15, randomMinSeconds: 60, randomMaxSeconds: 120 });
    const times = state.tweets.map((tweet) => new Date(tweet.scheduledAt).getTime()).sort((a, b) => a - b);
    expect(times[0]).toBe(startAt.getTime());
    expectRandomGaps(times);

    const bad = await PUT(
      new Request("http://localhost/api/queue", {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: 15, randomMinSeconds: 120, randomMaxSeconds: 60 }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_random" });
  });
});

describe("live timeline read", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the latest user posts and keeps the newest created_at", async () => {
    const x = createLiveXClient({
      apiKey: "key",
      apiSecret: "secret-value-123",
      accessToken: "token",
      accessTokenSecret: "token-secret",
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/2/users/42/tweets");
      expect(url).toContain("max_results=5");
      expect(url).toContain("exclude=retweets");
      expect(decodeURIComponent(url)).toContain("exclude=retweets,replies");
      expect(decodeURIComponent(url)).toContain("tweet.fields=created_at,referenced_tweets");
      return new Response(
        JSON.stringify({
          data: [
            { id: "older", created_at: "2026-06-01T10:00:00.000Z" },
            { id: "newer", created_at: "2026-06-01T11:00:00.000Z" },
            {
              id: "self-reply",
              created_at: "2026-06-01T12:00:00.000Z",
              referenced_tweets: [{ type: "replied_to", id: "newer" }],
            },
            {
              id: "quote",
              created_at: "2026-06-01T10:30:00.000Z",
              referenced_tweets: [{ type: "quoted", id: "x" }],
            },
            { id: "missing-time" },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(x.latestTweet!("42")).resolves.toEqual({
      id: "newer",
      createdAt: "2026-06-01T11:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
