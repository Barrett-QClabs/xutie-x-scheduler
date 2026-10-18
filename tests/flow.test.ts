import { afterEach, describe, expect, it } from "vitest";
import { DELETE as deleteCredentials, PUT as saveCredentialsRoute } from "@/app/api/credentials/route";
import { GET as getStateRoute } from "@/app/api/state/route";
import { decryptString, encryptString } from "@/lib/crypto";
import { getCredentialsRow, reopenDatabase } from "@/lib/db";
import { getPublicState, importTweets, pauseQueue, reorderTweet, resumeQueue, retryTweet, saveCredentials, updateTweetText } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import { createLiveXClient, XApiError, type XClient } from "@/lib/x-client";

const secret = "super-secret-value-xyz";

const user = { id: "1", username: "demo", name: "Demo" };

function client(postTweet: XClient["postTweet"]): XClient {
  return { verify: async () => user, postTweet };
}

function queueDue(source: string, startAt = new Date(Date.now() - 60_000).toISOString()) {
  return importTweets({
    source,
    format: "text",
    startAt,
    intervalMinutes: 15,
    jitterMinutes: 0,
  });
}

describe("credentials stay on the server", () => {
  it("encrypts at rest and does not return secrets from the state API", async () => {
    const response = await saveCredentialsRoute(
      new Request("http://local/api/credentials", {
        method: "PUT",
        body: JSON.stringify({
          apiKey: "abc12345",
          apiSecret: secret,
          accessToken: "token-value",
          accessTokenSecret: "token-secret-value",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toEqual({ ok: true });
    expect(JSON.stringify(saved)).not.toContain(secret);

    const row = getCredentialsRow();
    expect(row?.ciphertext).toBeTruthy();
    expect(row?.ciphertext).not.toContain(secret);
    expect(decryptString(row!.ciphertext)).toContain(secret);

    const stateResponse = await getStateRoute();
    const body = await stateResponse.json();
    expect(body.credentialsConfigured).toBe(true);
    expect(body.account).toBeNull();
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("token-secret-value");

    const cleared = await deleteCredentials();
    expect(cleared.status).toBe(200);
    expect(getPublicState().credentialsConfigured).toBe(false);
  });

  it("fails closed when the encryption key is wrong", () => {
    const payload = encryptString("plain-text", "test-encryption-key");
    expect(decryptString(payload, "test-encryption-key")).toBe("plain-text");
    expect(() => decryptString(payload, "another-key-value")).toThrow(/无法解密/);
  });
});

describe("import, queue, and mocked posting", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const originalFetch = global.fetch;

  it("queues valid posts, skips over-limit text, and posts only the due one", async () => {
    saveCredentials({
      apiKey: "abc12345",
      apiSecret: secret,
      accessToken: "token-value",
      accessTokenSecret: "token-secret-value",
    });
    let called = false;
    global.fetch = async () => {
      called = true;
      throw new Error("network");
    };

    const imported = queueDue(`第一条\n第二条\n${"中".repeat(12_501)}`);
    expect(imported.queued.map((tweet) => tweet.text)).toEqual(["第一条", "第二条"]);
    expect(imported.invalid).toHaveLength(1);
    expect(imported.invalid[0].reason).toBe("too_long");
    const gap =
      new Date(imported.queued[1].scheduledAt).getTime() - new Date(imported.queued[0].scheduledAt).getTime();
    expect(gap).toBe(15 * 60_000);

    const posted = await tick();
    expect(posted).toMatchObject({ action: "posted" });
    expect(called).toBe(false);

    const state = getPublicState();
    const first = state.tweets.find((tweet) => tweet.text === "第一条");
    const second = state.tweets.find((tweet) => tweet.text === "第二条");
    expect(first?.status).toBe("posted");
    expect(first?.tweetId).toMatch(/^mock_/);
    expect(first?.tweetUrl).toContain(first?.tweetId);
    expect(second?.status).toBe("pending");

    reopenDatabase();
    const later = await tick({ now: new Date(Date.now() + 16 * 60_000) });
    expect(later.action).toBe("posted");
    expect(getPublicState().tweets.find((tweet) => tweet.text === "第二条")?.status).toBe("posted");
  });

  it("backs off on 429, pauses on auth errors, and fails duplicates without stopping the queue", async () => {
    const reset = new Date(Date.now() + 60_000);
    queueDue("限流这条");
    const limited = await tick({
      client: client(async () => {
        throw new XApiError("Rate limit exceeded", "rate_limit", 429, reset);
      }),
    });
    expect(limited.action).toBe("rate_limited");
    expect(getPublicState().tweets[0].status).toBe("pending");
    expect(getPublicState().queue.paused).toBe(false);

    let calls = 0;
    await tick({
      now: new Date(),
      client: client(async () => {
        calls += 1;
        return { id: "should-not-post" };
      }),
    });
    expect(calls).toBe(0);

    const after = await tick({
      now: new Date(reset.getTime() + 1000),
      client: client(async () => ({ id: "after-limit" })),
    });
    expect(after).toMatchObject({ action: "posted", tweetId: "after-limit" });

    queueDue("鉴权这条\n下一条", new Date(Date.now() - 40 * 60_000).toISOString());
    const auth = await tick({
      now: new Date(),
      client: client(async () => {
        throw new XApiError("Invalid or expired token", "auth", 401);
      }),
    });
    expect(auth.action).toBe("auth_paused");
    expect(getPublicState().queue.paused).toBe(true);
    expect(getPublicState().tweets.find((tweet) => tweet.text === "鉴权这条")?.status).toBe("pending");

    await tick({
      client: client(async () => {
        throw new Error("should not be called while paused");
      }),
    });
    resumeQueue();
    const resumed = await tick({
      client: client(async () => ({ id: "resumed-id" })),
    });
    expect(resumed).toMatchObject({ action: "posted", tweetId: "resumed-id" });

    queueDue("重复这条");
    const duplicate = await tick({
      client: client(async () => {
        throw new XApiError("You are not allowed to create a Tweet with duplicate content.", "duplicate", 403);
      }),
    });
    expect(duplicate.action).toBe("failed");
    const failed = getPublicState().tweets.find((tweet) => tweet.text === "重复这条");
    expect(failed?.status).toBe("failed");
    expect(getPublicState().queue.paused).toBe(false);
    retryTweet(failed!.id, new Date());
    const retried = await tick({ client: client(async () => ({ id: "retried" })) });
    expect(retried).toMatchObject({ action: "posted", tweetId: "retried" });
  });

  it("retries transient errors and then marks the post failed", async () => {
    queueDue("不稳定");
    let cursor = new Date();
    const failing = client(async () => {
      throw new XApiError("Internal error", "transient", 503);
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await tick({ now: cursor, client: failing });
      expect(result.action).toBe("retry_later");
      cursor = new Date(getPublicState().tweets[0].scheduledAt);
    }
    const failed = await tick({ now: cursor, client: failing });
    expect(failed.action).toBe("failed");
    expect(getPublicState().tweets[0].attemptCount).toBe(5);
  });

  it("edits, reorders, deletes, and pauses the queue", async () => {
    const imported = queueDue("甲\n乙\n丙", new Date(Date.now() + 60 * 60_000).toISOString());
    const [first, second] = imported.queued;
    reorderTweet(first.id, "down");
    const reordered = getPublicState().tweets;
    expect(reordered.find((tweet) => tweet.id === first.id)?.scheduledAt).toBe(second.scheduledAt);
    expect(reordered.find((tweet) => tweet.id === second.id)?.scheduledAt).toBe(first.scheduledAt);

    updateTweetText(first.id, "甲改过了");
    expect(getPublicState().tweets.find((tweet) => tweet.id === first.id)?.text).toBe("甲改过了");
    expect(updateTweetText(first.id, "中".repeat(150)).isLong).toBe(true);
    expect(() => updateTweetText(first.id, "中".repeat(12_501))).toThrow(/25000/);

    pauseQueue();
    const paused = await tick({
      now: new Date(Date.now() + 3 * 60 * 60_000),
      client: client(async () => {
        throw new Error("paused queue must not post");
      }),
    });
    expect(paused.action).toBe("paused");

    const removed = imported.queued[2];
    const { DELETE } = await import("@/app/api/tweets/[id]/route");
    const response = await DELETE(new Request("http://local"), { params: Promise.resolve({ id: removed.id }) });
    expect(response.status).toBe(200);
    expect(getPublicState().tweets.some((tweet) => tweet.id === removed.id)).toBe(false);
  });
});

describe("long posts", () => {
  it("queues posts over 280 with a warning, allows ~10,000-char posts, and fails a rejected one alone", async () => {
    saveCredentials({
      apiKey: "abc12345",
      apiSecret: secret,
      accessToken: "token-value",
      accessTokenSecret: "token-secret-value",
    });
    const big = "长".repeat(10_000);
    const source = ["短的", "中".repeat(141), big, `${big}二`, `${big}三`, "x".repeat(25_001)].join("\n---\n");
    const imported = queueDue(source);
    expect(imported.queuedCount).toBe(5);
    expect(imported.longCount).toBe(4);
    expect(imported.invalid).toHaveLength(1);
    expect(imported.invalid[0].reason).toBe("too_long");
    expect(imported.queued[0].isLong).toBe(false);
    expect(imported.queued[1].isLong).toBe(true);
    expect(imported.queued[2].weightedLength).toBe(20_000);

    const first = await tick();
    expect(first.action).toBe("posted");
    const rejected = await tick({
      now: new Date(Date.now() + 16 * 60_000),
      client: client(async () => {
        throw new XApiError("X 拒绝了这条长文：可能需要 X Premium", "rejected", 403);
      }),
    });
    expect(rejected.action).toBe("failed");
    const state = getPublicState();
    expect(state.queue.paused).toBe(false);
    expect(state.tweets.find((tweet) => tweet.id === imported.queued[1].id)?.errorMessage).toContain("Premium");
    expect(state.counts.pending).toBe(3);
  });

  it("accepts an import source large enough for several long posts", () => {
    const source = Array.from({ length: 8 }, (_, index) => `${index}${"a".repeat(20_000)}`).join("\n---\n");
    expect(source.length).toBeGreaterThan(160_000);
    expect(queueDue(source).queuedCount).toBe(8);
  });
});

describe("live X client", () => {
  it("classifies rate limits, duplicates, and auth from the HTTP response", async () => {
    const credentials = {
      apiKey: "key",
      apiSecret: "secret-value-123",
      accessToken: "token",
      accessTokenSecret: "token-secret",
    };
    const x = createLiveXClient(credentials);
    const original = global.fetch;

    global.fetch = async () =>
      new Response(JSON.stringify({ data: { id: "99", name: "Ada", username: "ada" } }), { status: 200 });
    await expect(x.verify()).resolves.toMatchObject({ username: "ada", id: "99" });

    global.fetch = async (_url, init) => {
      const header = new Headers(init?.headers).get("authorization") ?? "";
      expect(header.startsWith("OAuth ")).toBe(true);
      expect(init?.body).toBe(JSON.stringify({ text: "hello" }));
      return new Response(JSON.stringify({ data: { id: "55", text: "hello" } }), { status: 201 });
    };
    await expect(x.postTweet("hello")).resolves.toEqual({ id: "55" });

    global.fetch = async () =>
      new Response(JSON.stringify({ detail: "Rate limit exceeded" }), {
        status: 429,
        headers: { "x-rate-limit-reset": "1800000000" },
      });
    await expect(x.postTweet("hello")).rejects.toMatchObject({
      kind: "rate_limit",
      resetAt: new Date(1800000000 * 1000),
    });

    global.fetch = async () =>
      new Response(
        JSON.stringify({ detail: "You are not allowed to create a Tweet with duplicate content." }),
        { status: 403 },
      );
    await expect(x.postTweet("hello")).rejects.toMatchObject({ kind: "duplicate" });

    global.fetch = async () =>
      new Response(
        JSON.stringify({ detail: "You are not permitted to create a Tweet with this length." }),
        { status: 403 },
      );
    const long = await x.postTweet("hello").catch((error: unknown) => error);
    expect(long).toMatchObject({ kind: "rejected", status: 403 });
    expect((long as Error).message).toContain("X Premium");

    global.fetch = async () =>
      new Response(JSON.stringify({ detail: "Not authorized: Premium subscription required for long posts" }), { status: 403 });
    await expect(x.postTweet("hello")).rejects.toMatchObject({ kind: "rejected" });

    global.fetch = async () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 });
    await expect(x.postTweet("hello")).rejects.toMatchObject({ kind: "auth" });

    global.fetch = original;
  });
});
