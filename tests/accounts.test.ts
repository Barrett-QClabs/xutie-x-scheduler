import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { POST as testCredentialsRoute } from "@/app/api/credentials/test/route";
import { PUT as saveCredentialsRoute } from "@/app/api/credentials/route";
import { parseAccountId } from "@/lib/account";
import { decryptString, encryptString } from "@/lib/crypto";
import { getCredentialsRow, getQueueSettings, listTweets, reopenDatabase, updateAccount } from "@/lib/db";
import { buildAuthorizationHeader } from "@/lib/oauth";
import { tick } from "@/lib/scheduler";
import {
  getPublicState,
  importTweets,
  pauseQueue,
  readCredentials,
  resumeQueue,
  retryTweet,
  saveCredentials,
  updateTweetText,
} from "@/lib/service";
import { createXClient, type XClient } from "@/lib/x-client";

const originals = {
  mode: process.env.X_API_MODE,
  database: process.env.DATABASE_PATH,
};

afterEach(() => {
  if (originals.mode === undefined) delete process.env.X_API_MODE;
  else process.env.X_API_MODE = originals.mode;
  if (originals.database === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originals.database;
  reopenDatabase();
});

const creds = (apiKey: string) => ({
  apiKey,
  apiSecret: `${apiKey}-secret`,
  accessToken: `${apiKey}-token`,
  accessTokenSecret: `${apiKey}-token-secret`,
});

function recordingClient(seen: string[]): XClient {
  return {
    verify: async () => ({ id: "user", username: "recorded", name: "Recorded" }),
    latestTweet: async () => null,
    postTweet: async (text) => {
      seen.push(text);
      return { id: `posted-${seen.length}-${text}` };
    },
  };
}

function request(path: string, body: Record<string, unknown>) {
  return new Request(`http://local${path}`, { method: "POST", body: JSON.stringify(body) });
}

describe("credential identity scope", () => {
  it("keeps account 1 when account 2 is saved and its verify fails", async () => {
    saveCredentials(1, creds("alpha-key"));
    updateAccount(1, { username: "kept_handle", displayName: "Kept", userId: "111" });
    const ciphertext = getCredentialsRow(1)?.ciphertext;

    const saved = await saveCredentialsRoute(
      new Request("http://local/api/credentials", {
        method: "PUT",
        body: JSON.stringify({ accountId: 2, ...creds("invalid") }),
      }),
    );
    expect(saved.status).toBe(200);
    const rejected = await testCredentialsRoute(request("/api/credentials/test", { accountId: 2 }));
    expect(rejected.status).toBe(400);
    const error = await rejected.json();
    expect(error.code).toBe("x_auth");
    expect(JSON.stringify(error)).not.toContain("invalid-secret");

    expect(getPublicState(new Date(), 1).account).toEqual({
      username: "kept_handle",
      displayName: "Kept",
      userId: "111",
    });
    expect(getCredentialsRow(1)?.ciphertext).toBe(ciphertext);
    const second = getPublicState(new Date(), 2);
    expect(second.credentialsConfigured).toBe(true);
    expect(second.account).toBeNull();
    expect(second.queue.paused).toBe(true);
  });

  it("clears only the saved account's identity until that account verifies again", async () => {
    saveCredentials(1, creds("alpha-key"));
    updateAccount(1, { username: "kept_handle", displayName: "Kept", userId: "111" });
    saveCredentials(2, creds("beta-key"));
    updateAccount(2, { username: "other_handle", displayName: "Other", userId: "222" });

    const saved = await saveCredentialsRoute(
      new Request("http://local/api/credentials", {
        method: "PUT",
        body: JSON.stringify({ accountId: 1, ...creds("invalid") }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(getPublicState(new Date(), 1).credentialsConfigured).toBe(true);
    expect(getPublicState(new Date(), 1).account).toBeNull();
    expect(getPublicState(new Date(), 2).account?.username).toBe("other_handle");

    const rejected = await testCredentialsRoute(request("/api/credentials/test", { accountId: 1 }));
    expect(rejected.status).toBe(400);
    expect(getPublicState(new Date(), 1).account).toBeNull();
    expect(readCredentials(2)?.apiKey).toBe("beta-key");
  });
});

describe("two X accounts stay isolated", () => {
  it("rejects a missing account instead of choosing one", () => {
    expect(() => parseAccountId(undefined)).toThrow(/账号1或账号2/);
    expect(() => parseAccountId(3)).toThrow(/账号1或账号2/);
    expect(() =>
      importTweets({
        accountId: undefined,
        source: "不应该入队",
        format: "text",
        startAt: new Date().toISOString(),
        intervalMinutes: 15,
      }),
    ).toThrow(/账号1或账号2/);
    expect(listTweets(1)).toHaveLength(0);
    expect(listTweets(2)).toHaveLength(0);
  });

  it("stores separate credentials and signs with the matching key", () => {
    saveCredentials(1, creds("account-one-key"));
    saveCredentials(2, creds("account-two-key"));
    const first = readCredentials(1);
    const second = readCredentials(2);
    expect(first?.apiKey).toBe("account-one-key");
    expect(second?.apiKey).toBe("account-two-key");
    expect(decryptString(getCredentialsRow(1)!.ciphertext)).toContain("account-one-key");
    expect(decryptString(getCredentialsRow(1)!.ciphertext)).not.toContain("account-two-key");
    expect(decryptString(getCredentialsRow(2)!.ciphertext)).not.toContain("account-one-key");

    const header1 = buildAuthorizationHeader({
      method: "POST",
      url: "https://api.x.com/2/tweets",
      credentials: first!,
      nonce: "n1",
      timestamp: "1",
    }).header;
    const header2 = buildAuthorizationHeader({
      method: "POST",
      url: "https://api.x.com/2/tweets",
      credentials: second!,
      nonce: "n2",
      timestamp: "1",
    }).header;
    expect(header1).toContain("account-one-key");
    expect(header1).not.toContain("account-two-key");
    expect(header2).toContain("account-two-key");
    expect(header2).not.toContain("account-one-key");
    expect(getPublicState().accountLabel).toBe("账号1");
    expect(getPublicState(new Date(), 2).accountLabel).toBe("账号2");
    expect(getPublicState().slots.map((slot) => slot.label)).toEqual(["账号1", "账号2"]);
  });

  it("posts, pauses, and retries each account without crossing or calling the network", async () => {
    const calls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    delete process.env.X_API_MODE;
    try {
      saveCredentials(1, creds("alpha-key"));
      saveCredentials(2, creds("beta-key"));
      const start = new Date(Date.now() - 60_000).toISOString();
      importTweets({ accountId: 1, source: "账号1的帖子", format: "text", startAt: start, intervalMinutes: 15, randomMinSeconds: 0, randomMaxSeconds: 0 });
      importTweets({ accountId: 2, source: "账号2的帖子", format: "text", startAt: start, intervalMinutes: 15, randomMinSeconds: 0, randomMaxSeconds: 0 });
      resumeQueue(2);

      const seen1: string[] = [];
      const seen2: string[] = [];
      const [left, right] = await Promise.all([
        tick({ accountId: 1, client: recordingClient(seen1), random: () => 0 }),
        tick({ accountId: 2, client: recordingClient(seen2), random: () => 0 }),
      ]);
      expect(left.action).toBe("posted");
      expect(right.action).toBe("posted");
      expect(seen1).toEqual(["账号1的帖子"]);
      expect(seen2).toEqual(["账号2的帖子"]);
      expect(getPublicState(new Date(), 1).tweets.map((tweet) => tweet.text)).toEqual(["账号1的帖子"]);
      expect(getPublicState(new Date(), 2).tweets.map((tweet) => tweet.text)).toEqual(["账号2的帖子"]);
      expect(calls).toEqual([]);

      const id1 = getPublicState(new Date(), 1).tweets[0].id;
      expect(() => updateTweetText(2, id1, "改到另一个号")).toThrow(/这个账号/);
      expect(() => retryTweet(2, id1)).toThrow(/这个账号/);
      expect(getPublicState(new Date(), 1).tweets[0].text).toBe("账号1的帖子");

      importTweets({
        accountId: 1,
        source: "账号1下一条",
        format: "text",
        startAt: new Date(Date.now() - 1000).toISOString(),
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      importTweets({
        accountId: 2,
        source: "账号2下一条",
        format: "text",
        startAt: new Date(Date.now() - 1000).toISOString(),
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      pauseQueue(1, "manual");
      const blocked = await tick({ accountId: 1, client: recordingClient(seen1), random: () => 0 });
      const second = await tick({ accountId: 2, client: recordingClient(seen2), random: () => 0 });
      expect(blocked.action).toBe("paused");
      expect(second.action).toBe("deferred");
      expect(seen1).toEqual(["账号1的帖子"]);
      expect(seen2).toEqual(["账号2的帖子"]);
      expect(getPublicState(new Date(), 1).counts.pending).toBe(1);
      expect(getPublicState(new Date(), 2).counts.pending).toBe(1);
      expect(getQueueSettings(1).paused).toBe(true);
      expect(getQueueSettings(2).paused).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("does not use the other account when live mode has no credentials", async () => {
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    process.env.X_API_MODE = "live";
    try {
      saveCredentials(1, creds("kept-key"));
      importTweets({
        accountId: 2,
        source: "没有凭据的号",
        format: "text",
        startAt: new Date(Date.now() - 1000).toISOString(),
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      resumeQueue(2);
      const result = await tick({ accountId: 2, random: () => 0 });
      expect(result.action).toBe("no_credentials");
      expect(getQueueSettings(2).paused).toBe(true);
      expect(getQueueSettings(1).paused).toBe(false);
      expect(readCredentials(1)?.apiKey).toBe("kept-key");
      expect(readCredentials(2)).toBeNull();
      expect(listTweets(2)[0].status).toBe("pending");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("uses each account's own saved key when the mock client is created", async () => {
    delete process.env.X_API_MODE;
    saveCredentials(1, creds("alpha-key"));
    saveCredentials(2, creds("beta-key"));
    const names = [1, 2] as const;
    for (const accountId of names) {
      const user = await createXClient(readCredentials(accountId)!).verify();
      expect(user.username).toBe(accountId === 1 ? "mock_alphakey" : "mock_betakey");
    }
  });

  it("keeps an old single-account database on 账号1 and starts 账号2 paused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-old-account-"));
    const file = path.join(dir, "old.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        user_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE queue_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        interval_minutes INTEGER NOT NULL,
        jitter_minutes INTEGER NOT NULL,
        paused INTEGER NOT NULL,
        pause_reason TEXT,
        rate_limit_until TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tweets (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        weighted_length INTEGER NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        posted_at TEXT,
        tweet_id TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cipher = encryptString(JSON.stringify(creds("legacy-key")));
    db.prepare(
      `INSERT INTO credentials (id, ciphertext, username, display_name, user_id, updated_at)
       VALUES (1, ?, 'legacy', 'Legacy', 'legacy-user', '2026-11-07T00:00:00.000Z')`,
    ).run(cipher);
    db.prepare(
      `INSERT INTO queue_settings
        (id, interval_minutes, jitter_minutes, paused, pause_reason, rate_limit_until, last_error, updated_at)
       VALUES (1, 20, 0, 0, NULL, NULL, NULL, '2026-11-07T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO tweets
        (id, text, weighted_length, status, scheduled_at, posted_at, tweet_id, error_message, attempt_count, sort_order, created_at, updated_at)
       VALUES ('old-1', '旧队列', 3, 'pending', '2026-11-07T01:00:00.000Z', NULL, NULL, NULL, 0, 1, '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`,
    ).run();
    db.close();

    process.env.DATABASE_PATH = file;
    reopenDatabase();
    expect(readCredentials(1)?.apiKey).toBe("legacy-key");
    expect(readCredentials(2)).toBeNull();
    expect(listTweets(1).map((tweet) => tweet.text)).toEqual(["旧队列"]);
    expect(listTweets(2)).toEqual([]);
    expect(getQueueSettings(1)).toMatchObject({ paused: false, intervalMinutes: 20 });
    expect(getQueueSettings(2)).toMatchObject({ paused: true, pauseReason: "safe_start" });
    expect(getPublicState(new Date("2026-11-08T00:00:00.000Z"), 1).counts.pending).toBe(1);
    expect(getPublicState(new Date("2026-11-08T00:00:00.000Z"), 2).counts).toEqual({ pending: 0, posted: 0, failed: 0 });
  });
});
