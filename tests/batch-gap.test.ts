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
    jitterMinutes: 0,
  });
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
    const gap =
      new Date(imported.queued[49].scheduledAt).getTime() - new Date(imported.queued[0].scheduledAt).getTime();
    expect(gap).toBe(49 * 15 * 60_000);
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

    const deferred = await tick({ now, client });
    const earliest = new Date(latestAt.getTime() + 15 * 60_000);
    expect(deferred).toEqual({ action: "deferred", until: earliest.toISOString(), manual: true });
    expect(posts).toBe(0);
    expect(reads).toBe(1);

    const shifted = getPublicState().tweets;
    expect(new Date(shifted[0].scheduledAt).toISOString()).toBe(earliest.toISOString());
    expect(new Date(shifted[1].scheduledAt).getTime() - new Date(shifted[0].scheduledAt).getTime()).toBe(originalGap);
    expect(shifted.every((tweet) => tweet.delayReason === "manual")).toBe(true);

    patchTweet(shifted[0].id, { scheduledAt: now.toISOString() });
    const cached = await tick({ now: new Date(now.getTime() + 1000), client });
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
    expect(new Date(next!.scheduledAt).toISOString()).toBe(new Date(postedAt.getTime() + 15 * 60_000).toISOString());
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
    const deferred = await tick({ now, client });
    expect(deferred).toMatchObject({ action: "deferred", manual: false });
    expect(reads).toBe(1);
    expect(getTimelineCache().ok).toBe(false);
    expect(warn).toHaveBeenCalledWith("[序帖] 读取最近帖子失败，改用本工具自己的上次发送时间。", "timeline down");
    const next = getPublicState().tweets.find((tweet) => tweet.text === "下一条");
    expect(next?.delayReason).toBeNull();
    expect(new Date(next!.scheduledAt).toISOString()).toBe(new Date(postedAt.getTime() + 15 * 60_000).toISOString());

    patchTweet(pending.id, { scheduledAt: new Date(now.getTime() + 30_000).toISOString() });
    const again = await tick({ now: new Date(now.getTime() + 30_000), client });
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
