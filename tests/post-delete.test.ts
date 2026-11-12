import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/posts/delete/route";
import { GET as getDeleteStatus } from "@/app/api/posts/delete/status/route";
import type { AccountId } from "@/lib/account";
import { getDb, getQueueSettings, listPostDeleteLog, listTweets } from "@/lib/db";
import { delay, deleteOwnPosts, parseTweetIdList, POST_DELETE_MAX_IDS, resolvePostDeleteIntervalMs } from "@/lib/post-delete";
import { importTweets, saveCredentials } from "@/lib/service";
import { XApiError } from "@/lib/x-client";

const secret = "account-1-secret";
const token = "account-1-token";

function creds(account: AccountId) {
  return {
    apiKey: `account-${account}-key`,
    apiSecret: `account-${account}-secret`,
    accessToken: `account-${account}-token`,
    accessTokenSecret: `account-${account}-token-secret`,
  };
}

function postRequest(accountId: AccountId, body: unknown): Request {
  return new Request(`http://local/api/posts/delete?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const deleted = { data: { deleted: true } };

afterEach(() => {
  delete process.env.POST_DELETE_INTERVAL_MS;
});

describe("post delete request parsing", () => {
  it("accepts up to 200 numeric strings and drops duplicates", () => {
    const ids = Array.from({ length: POST_DELETE_MAX_IDS }, (_, index) => String(index + 1));
    expect(parseTweetIdList(ids).ids).toHaveLength(POST_DELETE_MAX_IDS);
    expect(parseTweetIdList(["10", "10", "11"])).toEqual({ ids: ["10", "11"], duplicateCount: 1 });
  });

  it("rejects an empty list, a numeric id, and a 201st id", () => {
    expect(() => parseTweetIdList([])).toThrow(/不能为空/);
    expect(() => parseTweetIdList([1888888888888888888])).toThrow(/数字字符串/);
    expect(() => parseTweetIdList(["12a"])).toThrow(/数字字符串/);
    const ids = Array.from({ length: POST_DELETE_MAX_IDS + 1 }, (_, index) => String(index + 1));
    expect(() => parseTweetIdList(ids)).toThrow(/200/);
  });

  it("keeps the gap inside 5 to 10 seconds", () => {
    expect(resolvePostDeleteIntervalMs(undefined)).toBe(7_000);
    expect(resolvePostDeleteIntervalMs(5_000)).toBe(5_000);
    expect(resolvePostDeleteIntervalMs(10_000)).toBe(10_000);
    process.env.POST_DELETE_INTERVAL_MS = "6000";
    expect(resolvePostDeleteIntervalMs(undefined)).toBe(6_000);
    expect(() => resolvePostDeleteIntervalMs(4_999)).toThrow(/5000/);
    process.env.POST_DELETE_INTERVAL_MS = "0";
    expect(() => resolvePostDeleteIntervalMs(undefined)).toThrow(/5000/);
  });
});

describe("post delete batch", () => {
  it("deletes serially and waits only between real writes", async () => {
    const events: string[] = [];
    const result = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["1", "1", "2", "3"],
      intervalMs: 8_000,
      now: () => "2026-11-12T00:00:00.000Z",
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
      deleteOnX: async (accountId, tweetId) => {
        events.push(`${accountId}:${tweetId}`);
        return deleted;
      },
    });

    expect(events).toEqual(["1:1", "sleep:8000", "1:2", "sleep:8000", "1:3"]);
    expect(result).toMatchObject({
      ok: true,
      stopped: false,
      stopReason: null,
      attempted: 3,
      skipped: 0,
      duplicateCount: 1,
      remaining: [],
    });
    expect(result.processed.map((item) => item.status)).toEqual(["deleted", "deleted", "deleted"]);
    expect(listPostDeleteLog(1).map((item) => item.tweetId)).toEqual(["1", "2", "3"]);
  });

  it("records 404 as already gone and continues", async () => {
    const seen: string[] = [];
    const result = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["4", "5"],
      intervalMs: 5_000,
      sleep: async () => {},
      deleteOnX: async (_accountId, tweetId) => {
        seen.push(tweetId);
        if (tweetId === "4") throw new XApiError("not found", "rejected", 404);
        return deleted;
      },
    });

    expect(seen).toEqual(["4", "5"]);
    expect(result.ok).toBe(true);
    expect(result.processed.map((item) => [item.tweetId, item.status, item.httpStatus])).toEqual([
      ["4", "already_gone", 404],
      ["5", "deleted", 200],
    ]);
  });

  it("stops on 429 and keeps the remaining ids unattempted", async () => {
    const seen: string[] = [];
    const result = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["6", "7", "8"],
      intervalMs: 5_000,
      sleep: async () => {},
      deleteOnX: async (_accountId, tweetId) => {
        seen.push(tweetId);
        if (tweetId === "7") throw new XApiError("rate limit", "rate_limit", 429);
        return deleted;
      },
    });

    expect(seen).toEqual(["6", "7"]);
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("rate_limit");
    expect(result.remaining).toEqual(["8"]);
    expect(listPostDeleteLog(1)).toEqual([
      expect.objectContaining({ tweetId: "6", status: "deleted", httpStatus: 200 }),
      expect.objectContaining({ tweetId: "7", status: "error", httpStatus: 429 }),
    ]);
    expect(JSON.stringify(result)).not.toContain("rate limit");
  });

  it("stops on a transport failure or a body that is not deleted", async () => {
    const http = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["20", "21"],
      intervalMs: 0,
      deleteOnX: async () => {
        throw new XApiError("unavailable", "transient", 503);
      },
    });
    expect(http.stopReason).toBe("http_error");
    expect(http.processed[0]).toMatchObject({ status: "error", httpStatus: 503 });
    expect(http.remaining).toEqual(["21"]);

    const network = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["22", "23"],
      intervalMs: 0,
      deleteOnX: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(network.stopReason).toBe("network");
    expect(network.processed[0].httpStatus).toBeNull();
    expect(JSON.stringify(network)).not.toContain("socket hang up");

    const offline = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["24"],
      intervalMs: 0,
      deleteOnX: async () => {
        throw new XApiError("offline", "transient", 0);
      },
    });
    expect(offline.stopReason).toBe("network");
    expect(offline.processed[0].httpStatus).toBe(0);

    const declined = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["25", "26"],
      intervalMs: 0,
      deleteOnX: async () => ({ data: { deleted: false } }),
    });
    expect(declined.stopReason).toBe("not_deleted");
    expect(declined.processed[0]).toMatchObject({ status: "error", httpStatus: 200 });
    expect(declined.remaining).toEqual(["26"]);
  });

  it("skips settled ids and retries an earlier error", async () => {
    await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["31"],
      intervalMs: 0,
      now: () => "2026-11-12T00:00:00.000Z",
      deleteOnX: async () => {
        throw new XApiError("not found", "rejected", 404);
      },
    });
    await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["30"],
      intervalMs: 0,
      now: () => "2026-11-12T00:00:00.000Z",
      deleteOnX: async () => {
        throw new XApiError("rate limit", "rate_limit", 429);
      },
    });

    const seen: string[] = [];
    const second = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["30", "31", "32"],
      intervalMs: 0,
      now: () => "2026-11-12T01:00:00.000Z",
      deleteOnX: async (_accountId, tweetId) => {
        seen.push(tweetId);
        return deleted;
      },
    });
    expect(seen).toEqual(["30", "32"]);
    expect(second.processed).toEqual([
      expect.objectContaining({ tweetId: "30", status: "deleted", skipped: false, at: "2026-11-12T01:00:00.000Z" }),
      expect.objectContaining({ tweetId: "31", status: "already_gone", skipped: true, at: "2026-11-12T00:00:00.000Z" }),
      expect.objectContaining({ tweetId: "32", status: "deleted", skipped: false, at: "2026-11-12T01:00:00.000Z" }),
    ]);

    const third = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["30", "31"],
      intervalMs: 8_000,
      sleep: async () => {
        throw new Error("settled ids must not wait");
      },
      deleteOnX: async () => deleted,
    });
    expect(third.skipped).toBe(2);
    expect(third.attempted).toBe(0);
  });

  it("keeps each account's log and credentials apart", async () => {
    await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["40"],
      intervalMs: 0,
      deleteOnX: async () => deleted,
    });
    const seen: AccountId[] = [];
    await deleteOwnPosts({
      accountId: 2,
      tweetIds: ["40"],
      intervalMs: 0,
      deleteOnX: async (accountId) => {
        seen.push(accountId);
        return deleted;
      },
    });
    expect(seen).toEqual([2]);
    expect(listPostDeleteLog(1)).toHaveLength(1);
    expect(listPostDeleteLog(2)).toHaveLength(1);
  });

  it("stops during the gap when the request is aborted", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["50", "51"],
      intervalMs: 5_000,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
      deleteOnX: async (_accountId, tweetId) => {
        seen.push(tweetId);
        return deleted;
      },
    });
    expect(seen).toEqual(["50"]);
    expect(result.stopReason).toBe("aborted");
    expect(result.remaining).toEqual(["51"]);
    expect(listPostDeleteLog(1).map((item) => item.tweetId)).toEqual(["50"]);
  });

  it("ends a gap immediately when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = delay(30_000, controller.signal);
    controller.abort();
    await pending;
  });

  it("does not rewrite the queue or follow tables", async () => {
    importTweets({
      accountId: 1,
      source: "队列里的草稿",
      format: "text",
      startAt: "2026-11-12T00:00:00.000Z",
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    const before = {
      tweets: listTweets(1),
      queue1: getQueueSettings(1),
      queue2: getQueueSettings(2),
      unfollow: count("SELECT COUNT(*) AS n FROM unfollow_candidates"),
      reserve: count("SELECT COUNT(*) AS n FROM follow_reserve"),
      batches: count("SELECT COUNT(*) AS n FROM follow_batches"),
    };
    await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["60"],
      intervalMs: 0,
      deleteOnX: async () => deleted,
    });
    expect(listTweets(1)).toEqual(before.tweets);
    expect(getQueueSettings(1)).toEqual(before.queue1);
    expect(getQueueSettings(2)).toEqual(before.queue2);
    expect(count("SELECT COUNT(*) AS n FROM unfollow_candidates")).toBe(before.unfollow);
    expect(count("SELECT COUNT(*) AS n FROM follow_reserve")).toBe(before.reserve);
    expect(count("SELECT COUNT(*) AS n FROM follow_batches")).toBe(before.batches);
    expect(listTweets(1)[0]?.text).toBe("队列里的草稿");
  });
});

describe("post delete routes", () => {
  it("refuses mock mode and a missing account before calling X", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls.push("fetch");
      throw new Error("network");
    };
    try {
      saveCredentials(1, creds(1));
      const mocked = await POST(postRequest(1, ["70"]));
      expect(mocked.status).toBe(400);
      expect((await mocked.json()).code).toBe("mock_mode");

      const missingAccount = await POST(new Request("http://local/api/posts/delete", {
        method: "POST",
        body: JSON.stringify(["70"]),
      }));
      expect(missingAccount.status).toBe(400);
      expect((await missingAccount.json()).code).toBe("account_required");
      expect(calls).toEqual([]);
      expect(listPostDeleteLog(1)).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses only that account's stored credentials and DELETE /2/tweets/:id", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push(`${method} ${url}`);
      if (method === "GET") throw new Error("developer API read");
      const header = new Headers(init?.headers).get("authorization") ?? "";
      expect(header.includes("account-2-key")).toBe(true);
      expect(header.includes("account-1-key")).toBe(false);
      return new Response(JSON.stringify(deleted), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      saveCredentials(1, creds(1));
      saveCredentials(2, creds(2));
      importTweets({
        accountId: 2,
        source: "账号2的队列",
        format: "text",
        startAt: "2026-11-12T00:00:00.000Z",
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      const queued = listTweets(2);
      const response = await POST(new Request("http://local/api/posts/delete?accountId=2", {
        method: "POST",
        body: JSON.stringify({ accountId: 1, tweetIds: ["1888888888888888888"], intervalMs: 9_000 }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        accountId: 2,
        intervalMs: 9_000,
        attempted: 1,
        processed: [{ tweetId: "1888888888888888888", status: "deleted", httpStatus: 200, skipped: false }],
      });
      expect(calls).toEqual(["DELETE https://api.x.com/2/tweets/1888888888888888888"]);
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain(token);
      expect(JSON.stringify(body)).not.toContain("account-2-secret");
      expect(JSON.stringify(listPostDeleteLog(2))).not.toContain("account-2-secret");
      expect(listPostDeleteLog(1)).toEqual([]);
      expect(listTweets(2)).toEqual(queued);

      globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Could not find tweet" }), { status: 404 });
      const gone = await POST(postRequest(2, ["1888888888888888889"]));
      const goneBody = await gone.json();
      expect(goneBody.processed[0]).toMatchObject({ status: "already_gone", httpStatus: 404, skipped: false });
      expect(JSON.stringify(goneBody)).not.toContain("Could not find tweet");
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("returns the partial batch when X responds 429", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      if (method === "GET") throw new Error("developer API read");
      const header = new Headers(init?.headers).get("authorization") ?? "";
      expect(header.includes("account-1-key")).toBe(true);
      return new Response(JSON.stringify({ detail: "Rate limit exceeded" }), { status: 429 });
    };
    try {
      saveCredentials(1, creds(1));
      const response = await POST(postRequest(1, ["71", "72"]));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.stopReason).toBe("rate_limit");
      expect(body.processed[0]).toMatchObject({ tweetId: "71", status: "error", httpStatus: 429 });
      expect(body.remaining).toEqual(["72"]);
      expect(calls).toEqual(["DELETE https://api.x.com/2/tweets/71"]);
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain("Rate limit exceeded");
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("does not call X for an invalid body, a short gap, or missing credentials", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls.push("fetch");
      throw new Error("network");
    };
    try {
      const badId = await POST(postRequest(1, [123]));
      expect(badId.status).toBe(400);
      const shortGap = await POST(postRequest(1, { tweetIds: ["73"], intervalMs: 1000 }));
      expect(shortGap.status).toBe(400);
      expect((await shortGap.json()).code).toBe("invalid_interval");
      const missing = await POST(postRequest(1, ["73"]));
      expect(missing.status).toBe(400);
      expect((await missing.json()).code).toBe("credentials_missing");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("blocks a second batch for the same account and lets the other account run", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    saveCredentials(1, creds(1));
    saveCredentials(2, creds(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") throw new Error("developer API read");
      const url = String(input);
      if (url.endsWith("/2/tweets/81")) {
        started();
        await gate;
      }
      return new Response(JSON.stringify(deleted), { status: 200, headers: { "content-type": "application/json" } });
    };
    const first = POST(postRequest(1, ["81"]));
    try {
      await startedPromise;
      const blocked = await POST(postRequest(1, ["82"]));
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).code).toBe("delete_in_progress");
      const other = await POST(postRequest(2, ["83"]));
      expect(other.status).toBe(200);
      expect((await other.json()).processed[0]).toMatchObject({ tweetId: "83", status: "deleted" });
    } finally {
      release();
      const finished = await first;
      expect(finished.status).toBe(200);
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("reads the local log and does not call X", async () => {
    await deleteOwnPosts({
      accountId: 1,
      tweetIds: ["90"],
      intervalMs: 0,
      now: () => "2026-11-12T03:00:00.000Z",
      deleteOnX: async () => deleted,
    });
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls.push("fetch");
      throw new Error("network");
    };
    try {
      const response = await getDeleteStatus(new Request("http://local/api/posts/delete/status?accountId=1"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({
        accountId: 1,
        count: 1,
        records: [{ tweetId: "90", status: "deleted", httpStatus: 200, at: "2026-11-12T03:00:00.000Z" }],
      });
      const other = await getDeleteStatus(new Request("http://local/api/posts/delete/status?accountId=2"));
      expect(await other.json()).toEqual({ accountId: 2, count: 0, records: [] });
      const missing = await getDeleteStatus(new Request("http://local/api/posts/delete/status"));
      expect(missing.status).toBe(400);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("post delete stays a write", () => {
  it("does not reference a developer read or the queue mutators", () => {
    const files = [
      "lib/post-delete.ts",
      "app/api/posts/delete/route.ts",
      "app/api/posts/delete/status/route.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/\bxGet\b/);
      expect(source).not.toMatch(/\bxPost\b/);
      expect(source).not.toMatch(/\/2\/users/);
      expect(source).not.toMatch(/method:\s*["']GET["']/);
      expect(source).not.toMatch(/deleteTweet\(/);
      expect(source).not.toMatch(/patchTweet/);
      expect(source).not.toMatch(/patchQueueSettings/);
    }
  });
});

function count(sql: string): number {
  return (getDb().prepare(sql).get() as { n: number }).n;
}
