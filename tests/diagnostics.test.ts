import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GET as getDiagnostics } from "@/app/api/diagnostics/route";
import { getDb, getQueueSettings, patchQueueSettings, reopenDatabase } from "@/lib/db";
import { buildActivity, classifyStoredFailure, describeMockScenario, diagnoseHttpStatus, queuePolicy } from "@/lib/diagnostics";
import { getPublicState, importTweets, resumeQueue, saveCredentials } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import type { QueueSettings } from "@/lib/types";
import { classifyStatus, createMockXClient, toXApiError, XApiError, type XClient } from "@/lib/x-client";

const originalFetch = global.fetch;
const user = { id: "42", username: "demo", name: "Demo" };

afterEach(() => {
  global.fetch = originalFetch;
});

function queue(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    intervalMinutes: 15,
    randomMinSeconds: 0,
    randomMaxSeconds: 0,
    paused: false,
    pauseReason: null,
    rateLimitUntil: null,
    lastError: null,
    lastTickAt: null,
    lastTickAction: null,
    ...overrides,
  };
}

function row(partial: {
  status: string;
  scheduledAt?: string;
  postedAt?: string | null;
  tweetId?: string | null;
  errorMessage?: string | null;
  errorKind?: string | null;
}) {
  return {
    scheduledAt: partial.scheduledAt ?? "2026-11-07T08:00:00.000Z",
    postedAt: partial.postedAt ?? null,
    tweetId: partial.tweetId ?? null,
    errorMessage: partial.errorMessage ?? null,
    errorKind: partial.errorKind ?? null,
    status: partial.status,
  };
}

function throwingFetch(calls: string[]) {
  global.fetch = async () => {
    calls.push("fetch");
    throw new Error("offline test must not call X");
  };
}

describe("HTTP status classes stay distinct", () => {
  it("lets the status code win when the message names a different problem", async () => {
    expect(classifyStatus(402, "Rate limit exceeded", { title: "CreditsDepleted" })).toBe("credits");
    expect(classifyStatus(429, "Credits depleted", {})).toBe("rate_limit");
    expect(classifyStatus(401, "You are not allowed to create a Tweet with duplicate content.", {})).toBe("auth");
    expect(classifyStatus(403, "Forbidden", {})).toBe("auth");
    expect(classifyStatus(403, "Forbidden: your token does not have permission to post.", {})).toBe("auth");
    expect(classifyStatus(403, "You are not allowed to create a Tweet with duplicate content.", {})).toBe("duplicate");
    expect(classifyStatus(403, "You are not permitted to create a Tweet with this length.", {})).toBe("rejected");
    expect(classifyStatus(400, "Invalid request", {})).toBe("rejected");
    expect(classifyStatus(503, "Internal error", {})).toBe("transient");

    const credits = await toXApiError(new Response(JSON.stringify({ detail: "Rate limit exceeded" }), { status: 402 }));
    const limited = await toXApiError(
      new Response(JSON.stringify({ detail: "Credits depleted" }), {
        status: 429,
        headers: { "x-rate-limit-reset": "1800000000" },
      }),
    );
    expect(credits.kind).toBe("credits");
    expect(credits.status).toBe(402);
    expect(limited.kind).toBe("rate_limit");
    expect(diagnoseHttpStatus(402, "Rate limit exceeded").lastError).toBe("credits");
    expect(diagnoseHttpStatus(429, "Credits depleted").lastError).toBe("rate_limit");
    expect(queuePolicy("duplicate")).toMatchObject({ pauseQueue: false, keepPending: false, continueLaterPosts: true });
    expect(queuePolicy("credits").lastError).not.toBe(queuePolicy("rate_limit").lastError);
  });

  it("reads a legacy duplicate message without rewriting the row", () => {
    expect(classifyStoredFailure(null, "You are not allowed to create a Tweet with duplicate content.")).toBe("duplicate");
    expect(classifyStoredFailure("credits", "Rate limit exceeded")).toBe("credits");
    expect(classifyStoredFailure(null, "You are not permitted to create a Tweet with this length.")).toBe("other");
  });
});

describe("queue phases do not collapse into one another", () => {
  const now = new Date("2026-11-07T08:52:00.000Z");

  it("treats pending 0 with history as idle, and a missing heartbeat as unknown", () => {
    const idle = buildActivity({
      now,
      queue: queue(),
      tweets: [
        row({ status: "posted", postedAt: "2026-11-07T04:00:00.000Z", tweetId: "100" }),
        row({
          status: "failed",
          errorMessage: "You are not allowed to create a Tweet with duplicate content.",
        }),
      ],
    });
    expect(idle.phase).toBe("idle");
    expect(idle.fault).toBeNull();
    expect(idle.pending).toBe(0);
    expect(idle.posted).toBe(1);
    expect(idle.failed).toBe(1);
    expect(idle.failureKinds.duplicate).toBe(1);
    expect(idle.scheduler).toBe("unknown");
    expect(idle.lastSuccessTweetId).toBe("100");
  });

  it("gives empty, paused, draft-unrelated rows, waiting, and due their own phases", () => {
    const empty = buildActivity({ now, queue: queue(), tweets: [] });
    const paused = buildActivity({ now, queue: queue({ paused: true, pauseReason: "manual" }), tweets: [] });
    const missing = buildActivity({
      now,
      queue: queue({ paused: true, pauseReason: "missing_credentials" }),
      tweets: [row({ status: "pending", scheduledAt: "2026-11-07T08:00:00.000Z" })],
    });
    const auth = buildActivity({
      now,
      queue: queue({ paused: true, pauseReason: "Invalid or expired token", lastError: "auth" }),
      tweets: [row({ status: "pending" })],
    });
    const credits = buildActivity({
      now,
      queue: queue({ rateLimitUntil: "2026-11-07T09:02:00.000Z", lastError: "credits" }),
      tweets: [row({ status: "pending" })],
    });
    const limited = buildActivity({
      now,
      queue: queue({ rateLimitUntil: "2026-11-07T09:02:00.000Z", lastError: "rate_limit" }),
      tweets: [row({ status: "pending" })],
    });
    const scheduled = buildActivity({
      now,
      queue: queue(),
      tweets: [row({ status: "pending", scheduledAt: "2026-11-07T10:00:00.000Z" })],
    });
    const due = buildActivity({
      now,
      queue: queue(),
      tweets: [row({ status: "pending", scheduledAt: "2026-11-07T08:00:00.000Z" })],
    });
    const cancelled = buildActivity({
      now,
      queue: queue(),
      tweets: [row({ status: "posted", postedAt: "2026-11-07T04:00:00.000Z" }), row({ status: "cancelled" })],
    });

    const phases = [empty, paused, missing, auth, credits, limited, scheduled, due, cancelled].map((item) => item.phase);
    expect(phases).toEqual([
      "empty",
      "paused",
      "no_credentials",
      "auth_blocked",
      "credits_waiting",
      "rate_limited",
      "scheduled",
      "due",
      "idle",
    ]);
    expect(new Set(phases).size).toBe(phases.length);
    expect(cancelled.other).toBe(1);
    expect(cancelled.pending).toBe(0);
    expect(credits.fault).toBe("credits");
    expect(limited.fault).toBe("rate_limit");
    expect(empty.fault).toBeNull();
    expect(scheduled.fault).toBeNull();
    expect(due.fault).toBeNull();
  });

  it("marks a recorded check stale only after the threshold, and leaves a fresh one recent", () => {
    const stale = buildActivity({
      now,
      queue: queue({ lastTickAt: "2026-11-07T08:50:00.000Z", lastTickAction: "idle" }),
      tweets: [],
    });
    const recent = buildActivity({
      now,
      queue: queue({ lastTickAt: "2026-11-07T08:51:50.000Z", lastTickAction: "idle" }),
      tweets: [],
    });
    expect(stale.scheduler).toBe("stale");
    expect(recent.scheduler).toBe("recent");
  });
});

describe("scheduler stores 402 and 429 separately and keeps later posts moving", () => {
  it("waits on credits without labeling the queue rate-limited", async () => {
    const calls: string[] = [];
    throwingFetch(calls);
    const now = new Date();
    importTweets({
      source: "甲\n乙",
      format: "text",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    let posts = 0;
    const client: XClient = {
      verify: async () => user,
      latestTweet: async () => null,
      postTweet: async () => {
        posts += 1;
        throw new XApiError("Rate limit exceeded", "credits", 402);
      },
    };
    const result = await tick({ now, client, random: () => 0 });
    expect(result).toMatchObject({ action: "credits_waiting" });
    const waiting = getPublicState(new Date(now.getTime() + 1000));
    expect(waiting.queue.lastError).toBe("credits");
    expect(waiting.activity.phase).toBe("credits_waiting");
    expect(waiting.tweets.every((tweet) => tweet.status === "pending")).toBe(true);
    expect(waiting.tweets[0].failureClass).toBe("credits");

    const follow = await tick({
      now: new Date(now.getTime() + 2000),
      random: () => 0,
      client: {
        verify: async () => user,
        latestTweet: async () => null,
        postTweet: async () => {
          posts += 1;
          return { id: "should-not-post" };
        },
      },
    });
    expect(follow.action).toBe("credits_waiting");
    expect(posts).toBe(1);
    expect(calls).toEqual([]);
    expect(getQueueSettings().lastTickAction).toBe("credits_waiting");
  });

  it("waits on 429 under rate_limit and still does not call X", async () => {
    const calls: string[] = [];
    throwingFetch(calls);
    const now = new Date();
    const reset = new Date(now.getTime() + 60_000);
    importTweets({
      source: "限频",
      format: "text",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    const result = await tick({
      now,
      random: () => 0,
      client: {
        verify: async () => user,
        latestTweet: async () => null,
        postTweet: async () => {
          throw new XApiError("Credits depleted", "rate_limit", 429, reset);
        },
      },
    });
    expect(result.action).toBe("rate_limited");
    const state = getPublicState(new Date(now.getTime() + 1000));
    expect(state.queue.lastError).toBe("rate_limit");
    expect(state.activity.phase).toBe("rate_limited");
    expect(state.activity.phase).not.toBe("credits_waiting");
    expect(state.tweets[0].status).toBe("pending");
    expect(state.tweets[0].failureClass).toBe("rate_limit");
    expect(calls).toEqual([]);
  });

  it("fails a duplicate and lets the next pending post fill the later slot", async () => {
    const calls: string[] = [];
    throwingFetch(calls);
    const now = new Date();
    importTweets({
      source: "[[duplicate]]\n补位这一条",
      format: "text",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
      random: () => 0,
    });
    const first = await tick({ now, random: () => 0 });
    expect(first.action).toBe("failed");
    const mid = getPublicState(now);
    const duplicate = mid.tweets.find((tweet) => tweet.text.includes("duplicate"));
    const next = mid.tweets.find((tweet) => tweet.text === "补位这一条");
    expect(duplicate?.status).toBe("failed");
    expect(duplicate?.failureClass).toBe("duplicate");
    expect(next?.status).toBe("pending");
    expect(mid.queue.paused).toBe(false);
    expect(mid.queue.lastError).toBeNull();
    expect(mid.activity.failureKinds.duplicate).toBe(1);

    const posted = await tick({ now: new Date(next!.scheduledAt), random: () => 0 });
    expect(posted).toMatchObject({ action: "posted" });
    const done = getPublicState();
    expect(done.tweets.find((tweet) => tweet.id === duplicate?.id)?.status).toBe("failed");
    expect(done.tweets.find((tweet) => tweet.id === next?.id)?.status).toBe("posted");
    expect(done.activity.phase).toBe("idle");
    expect(done.activity.fault).toBeNull();
    expect(calls).toEqual([]);

    resumeQueue();
    expect(getPublicState().tweets.find((tweet) => tweet.id === duplicate?.id)?.status).toBe("failed");
  });

  it("pauses on 401 and on a 403 permission error, and keeps the post pending", async () => {
    const now = new Date();
    importTweets({
      source: "[[forbidden]]",
      format: "text",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    const forbidden = await tick({ now, random: () => 0 });
    expect(forbidden.action).toBe("auth_paused");
    const state = getPublicState(now);
    expect(state.queue.paused).toBe(true);
    expect(state.queue.lastError).toBe("auth");
    expect(state.activity.phase).toBe("auth_blocked");
    expect(state.tweets[0].status).toBe("pending");
    expect(state.tweets[0].failureClass).toBe("auth");
  });

  it("runs mock markers without stored credentials and does not do that in live mode", async () => {
    const calls: string[] = [];
    throwingFetch(calls);
    const now = new Date();
    importTweets({
      source: "[[credits]]",
      format: "text",
      startAt: new Date(now.getTime() - 1000).toISOString(),
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    expect(getPublicState().credentialsConfigured).toBe(false);
    const mocked = await tick({ now, random: () => 0 });
    expect(mocked.action).toBe("credits_waiting");
    expect(calls).toEqual([]);

    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    try {
      const live = await tick({ now: new Date(now.getTime() + 11 * 60_000) });
      expect(live.action).toBe("no_credentials");
      expect(getPublicState().activity.phase).toBe("no_credentials");
      expect(getPublicState().tweets[0].status).toBe("pending");
      expect(calls).toEqual([]);
    } finally {
      process.env.X_API_MODE = previous;
    }
  });

  it("clears an expired credits wait and leaves an unrelated lastError in place", async () => {
    const now = new Date();
    patchQueueSettings({ rateLimitUntil: new Date(now.getTime() - 1000).toISOString(), lastError: "credits" });
    const cleared = await tick({
      now,
      client: {
        verify: async () => user,
        postTweet: async () => {
          throw new Error("no post is due");
        },
      },
    });
    expect(cleared.action).toBe("idle");
    expect(getQueueSettings().lastError).toBeNull();
    expect(getQueueSettings().rateLimitUntil).toBeNull();

    patchQueueSettings({ rateLimitUntil: new Date(now.getTime() - 1000).toISOString(), lastError: "kept-note" });
    await tick({
      now: new Date(now.getTime() + 1000),
      client: {
        verify: async () => user,
        postTweet: async () => {
          throw new Error("no post is due");
        },
      },
    });
    expect(getQueueSettings().lastError).toBe("kept-note");
  });
});

describe("offline diagnostics endpoint", () => {
  it("describes a mock scenario without posting or returning secrets", async () => {
    const calls: string[] = [];
    throwingFetch(calls);
    saveCredentials({
      apiKey: "abc12345",
      apiSecret: "diag-secret-value",
      accessToken: "token-value",
      accessTokenSecret: "token-secret-value",
    });
    const before = getPublicState().counts;
    const response = await getDiagnostics(new Request("http://local/api/diagnostics?scenario=credits"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.callsX).toBe(false);
    expect(body.scenario.kind).toBe("credits");
    expect(body.scenario.lastError).toBe("credits");
    expect(body.mockScenarios.map((item: { id: string }) => item.id)).toContain("duplicate");
    expect(describeMockScenario("rate_limit")?.kind).toBe("rate_limit");
    expect(JSON.stringify(body)).not.toContain("diag-secret-value");
    expect(JSON.stringify(body)).not.toContain("token-secret-value");
    expect(getPublicState().counts).toEqual(before);
    expect(calls).toEqual([]);

    const missing = await getDiagnostics(new Request("http://local/api/diagnostics?scenario=nope"));
    expect(missing.status).toBe(404);
  });

  it("maps each mock marker to the same class the mock client throws", async () => {
    const client = createMockXClient({
      apiKey: "mock-diagnostic",
      apiSecret: "mock-diagnostic",
      accessToken: "mock-diagnostic",
      accessTokenSecret: "mock-diagnostic",
    });
    const cases = ["credits", "rate_limit", "auth", "forbidden", "duplicate"] as const;
    for (const id of cases) {
      const scenario = describeMockScenario(id);
      expect(scenario).toBeTruthy();
      await expect(client.postTweet(scenario!.marker)).rejects.toMatchObject({ kind: scenario!.kind, status: scenario!.status });
    }
  });
});

describe("older databases stay compatible", () => {
  it("adds the new columns and does not revive cancelled or failed rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-old-"));
    const file = path.join(dir, "old.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
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
    db.prepare(
      `INSERT INTO queue_settings
        (id, interval_minutes, jitter_minutes, paused, pause_reason, rate_limit_until, last_error, updated_at)
       VALUES (1, 15, 0, 0, NULL, '2099-01-01T00:00:00.000Z', 'rate_limit', '2026-11-07T00:00:00.000Z')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO tweets
        (id, text, weighted_length, status, scheduled_at, posted_at, tweet_id, error_message, attempt_count, sort_order, created_at, updated_at)
       VALUES (?, ?, 2, ?, ?, ?, ?, ?, 1, ?, '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`,
    );
    insert.run("posted-1", "已经发出", "posted", "2026-11-07T01:00:00.000Z", "2026-11-07T01:00:00.000Z", "555", null, 1);
    insert.run(
      "failed-1",
      "重复旧帖",
      "failed",
      "2026-11-07T02:00:00.000Z",
      null,
      null,
      "You are not allowed to create a Tweet with duplicate content.",
      2,
    );
    insert.run("cancelled-1", "已取消", "cancelled", "2026-11-07T03:00:00.000Z", null, null, null, 3);
    db.close();

    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = file;
    try {
      reopenDatabase();
      const columns = getDb().prepare("PRAGMA table_info(tweets)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "error_kind")).toBe(true);
      const settings = getDb().prepare("PRAGMA table_info(queue_settings)").all() as Array<{ name: string }>;
      expect(settings.some((column) => column.name === "last_tick_at")).toBe(true);

      const seen = getPublicState(new Date("2026-11-07T08:00:00.000Z"));
      expect(seen.activity.phase).toBe("rate_limited");
      expect(seen.activity.fault).toBe("rate_limit");
      expect(seen.activity.failureKinds.duplicate).toBe(1);
      expect(seen.activity.other).toBe(1);
      expect(seen.counts).toEqual({ pending: 0, posted: 1, failed: 1 });

      const result = await tick({
        now: new Date("2026-11-07T08:00:00.000Z"),
        client: {
          verify: async () => user,
          postTweet: async () => {
            throw new Error("cancelled and historical rows must not be sent");
          },
        },
      });
      expect(result.action).toBe("rate_limited");
      const statuses = getDb().prepare("SELECT id, status FROM tweets ORDER BY sort_order").all() as Array<{
        id: string;
        status: string;
      }>;
      expect(statuses).toEqual([
        { id: "posted-1", status: "posted" },
        { id: "failed-1", status: "failed" },
        { id: "cancelled-1", status: "cancelled" },
      ]);
    } finally {
      process.env.DATABASE_PATH = previous;
      reopenDatabase();
    }
  });
});
