import { afterEach, describe, expect, it } from "vitest";
import { POST as submitFollow } from "@/app/api/follow/batches/route";
import { POST as resumeFollow } from "@/app/api/follow/resume/route";
import { GET as readEvidence, POST as postEvidence } from "@/app/api/evidence/route";
import { POST as submitUnfollow } from "@/app/api/unfollow/batches/route";
import { POST as resumeUnfollow } from "@/app/api/unfollow/resume/route";
import { getCredentialsRow, getQueueSettings, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { stockFollowReserve } from "@/lib/follow-queue";
import { tick } from "@/lib/scheduler";
import { importTweets, saveCredentials } from "@/lib/service";
import { importUnfollowCandidates, submitUnfollowBatch } from "@/lib/unfollow-queue";
import { createLiveXClient, xGet } from "@/lib/x-client";

const WORK = new Date("2026-11-08T08:00:00.000Z");
const OBSERVED = "2026-11-08T07:50:00.000Z";
const EXPIRES = "2026-11-08T08:30:00.000Z";

function envelope(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    account_id: "1933586991612080128",
    source_namespace: "user-X",
    source_tool: "get_users_me_following",
    observed_at: OBSERVED,
    expires_at: EXPIRES,
    request_fields: ["verified", "verified_type", "connection_status", "public_metrics"],
    coverage: { pagination_complete: false, next_token: "page-2", activity_window_complete: false, excluded: [] },
    errors: [],
    evidence_refs: ["contract_082a"],
    subjects: [
      {
        id: "555",
        username: "ada",
        name: "Ada",
        description: "hello",
        verified: true,
        verified_type: "blue",
        connection_status: ["following"],
        public_metrics: { followers_count: 50000 },
      },
    ],
    ...over,
  };
}

async function withFetch(run: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if ((init?.method ?? "GET") === "DELETE" || init?.method === "POST") {
      return new Response(JSON.stringify({ data: { following: false } }), { status: 200 });
    }
    return new Response("no read", { status: 500 });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("free evidence contract", () => {
  it("imports a sampled page without treating missing people or missing lang as proof", async () => {
    await withFetch(async (calls) => {
      const saved = saveCredentials(1, {
        apiKey: "acctoneA",
        apiSecret: "slot-one-secret-value",
        accessToken: "token",
        accessTokenSecret: "token-secret",
      });
      expect(saved.ok).toBe(true);
      updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
      const imported = importEvidence(1, envelope(), WORK);
      expect(imported.userDeveloperGets).toBe(0);
      expect(imported.paginationComplete).toBe(false);
      expect(imported.accepted).toEqual(["555"]);
      const verifiedOnly = importEvidence(1, envelope({
        observed_at: "2026-11-08T07:51:00.000Z",
        subjects: [{ id: "556", verified: true, connection_status: ["followed_by"] }],
      }), WORK);
      expect(verifiedOnly.accepted).toEqual(["556"]);
      const status = await (await readEvidence(new Request("http://local/api/evidence?accountId=1"))).json();
      expect(status.userDeveloperGets).toBe(0);
      expect(status.pages[0].paginationComplete).toBe(false);
      expect(status.pages[0].nextToken).toBe("page-2");
      expect(calls).toEqual([]);
      expect(getCredentialsRow(2)?.user_id ?? null).toBeNull();
    });
  });

  it("does not read on startup, resume, refill, or an incomplete batch, and writes only after complete evidence", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    await withFetch(async (calls) => {
      saveCredentials(1, {
        apiKey: "acctoneA",
        apiSecret: "slot-one-secret-value",
        accessToken: "token",
        accessTokenSecret: "token-secret",
      });
      updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
      const posted = importTweets({
        accountId: 1,
        source: "把我取关的人，不要和我说话",
        format: "text",
        startAt: "2026-11-08T06:25:46.000Z",
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      expect(await tick({ accountId: 2, now: WORK })).toMatchObject({ action: "paused" });
      expect(calls).toEqual([]);

      process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
      process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
      const resumed = await resumeUnfollow(new Request("http://local/api/unfollow/resume", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect((await resumed.json()).paused).toBe(false);
      await resumeFollow(new Request("http://local/api/follow/resume", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      const refilled = await postEvidence(new Request("http://local/api/evidence", {
        method: "POST",
        body: JSON.stringify({ accountId: 1, evidence: envelope() }),
      }));
      expect(refilled.status).toBe(200);
      expect(calls).toEqual([]);

      importUnfollowCandidates(1, { candidates: [{ targetUserId: "555", tier: "inactive_48h" }] });
      const blocked = await submitUnfollowBatch({ accountId: 1, now: new Date("2026-11-08T08:00:00.000Z") });
      expect(blocked.unfollowed).toBe(0);
      expect(calls).toEqual([]);

      importUnfollowCandidates(1, { candidates: [{ targetUserId: "558", tier: "inactive_48h" }] });
      importEvidence(1, envelope({
        observed_at: "2026-11-08T08:10:00.000Z",
        expires_at: "2026-11-08T09:00:00.000Z",
        source_tool: "get_users_posts",
        coverage: { pagination_complete: true, next_token: null, activity_window_complete: true, excluded: [], window: { from: "2026-11-06T00:00:00.000Z", to: "2026-11-08T08:20:00.000Z" } },
        subjects: [{
          id: "558",
          verified: true,
          verified_type: "blue",
          connection_status: ["following", "followed_by"],
          posts: [{ id: "p1", created_at: "2026-11-06T00:00:00.000Z", text: "old" }],
        }],
      }));
      const acted = await submitUnfollowBatch({ accountId: 1, now: new Date("2026-11-08T08:20:00.000Z") });
      expect(acted.unfollowed).toBe(1);
      expect(calls.some((item) => item.startsWith("DELETE"))).toBe(true);
      expect(calls.filter((item) => item.startsWith("GET"))).toEqual([]);

      stockFollowReserve(1, { checkedAt: OBSERVED, candidates: [{ targetUserId: "555", kind: "new", followersCount: 50000 }] });
      const follow = await submitFollow(new Request("http://local/api/follow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      const followBody = await follow.json();
      expect(followBody.followed ?? followBody.reason).toBeDefined();
      expect(calls.filter((item) => item.startsWith("GET"))).toEqual([]);
      expect(getQueueSettings(1).paused).toBe(false);
      expect(posted.queued[0].scheduledAt).toBe("2026-11-08T06:25:46.000Z");
    });
    process.env.X_API_MODE = previous;
  });

  it("blocks live identity reread and live user GETs before any socket", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    await withFetch(async (calls) => {
      saveCredentials(1, {
        apiKey: "acctoneA",
        apiSecret: "slot-one-secret-value",
        accessToken: "token",
        accessTokenSecret: "token-secret",
      });
      updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
      const { testCredentials } = await import("@/lib/service");
      const kept = await testCredentials(1);
      expect(kept.userId).toBe("1933586991612080128");
      expect(getCredentialsRow(1)?.username).toBe("barrett_tt");
      const client = createLiveXClient({
        apiKey: "acctoneA",
        apiSecret: "slot-one-secret-value",
        accessToken: "token",
        accessTokenSecret: "token-secret",
      });
      await expect(client.verify()).rejects.toThrow(/读额度已关闭/);
      await expect(xGet({
        apiKey: "acctoneA",
        apiSecret: "slot-one-secret-value",
        accessToken: "token",
        accessTokenSecret: "token-secret",
      }, "/2/users/me")).rejects.toThrow(/读额度已关闭/);
      expect(calls).toEqual([]);
    });
    process.env.X_API_MODE = previous;
  });
});
