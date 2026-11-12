import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { saveCredentials } from "@/lib/service";
import { UNFOLLOW_BATCH_LIMIT, UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
import { importUnfollowCandidates, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";

const NOW = new Date("2026-11-12T00:15:00.000Z");
const OLD_POST = "2026-11-09T23:00:00.000Z";
const EXACT_48H = "2026-11-10T00:15:00.000Z";

function enable(accountId: 1 | 2) {
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_UNFOLLOW" : "XUTIE_ACCOUNT2_UNFOLLOW"] = "on";
  saveCredentials(accountId, {
    apiKey: accountId === 1 ? "acctoneA" : "accttwoB",
    apiSecret: "slot-secret-value",
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(accountId, accountId === 1
    ? { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" }
    : { username: "boylittle18", displayName: "Boy", userId: "1468479269701820422" });
  setUnfollowPaused(accountId, false, "test");
}

function publicRead(accountId: 1 | 2, subjects: Array<Record<string, unknown>>) {
  return importEvidence(accountId, {
    schema_version: 1,
    account_id: accountId === 1 ? "1933586991612080128" : "1468479269701820422",
    source_namespace: accountId === 1 ? "user-X" : "user-X--english",
    source_tool: "get_users_posts",
    observed_at: "2026-11-11T23:50:00.000Z",
    expires_at: "2026-11-12T12:00:00.000Z",
    request_fields: ["verified", "verified_type", "connection_status", "created_at"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects,
  }, NOW);
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("account 1 deep inactive unfollow", () => {
  it("unfollows a deep inactive mutual from an old public post and leaves the shallow thousand, missing posts, and account 2 alone", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      seen.push(`${method} ${String(input)}`);
      if (method === "DELETE") return new Response("{}", { status: 200 });
      throw new Error("network");
    };
    try {
      enable(1);
      enable(2);
      const imported = importUnfollowCandidates(1, {
        candidates: [
          { targetUserId: "91001", tier: "non_blue", followingRank: 1400 },
          { targetUserId: "91002", tier: "inactive_48h", followingRank: 1001 },
          { targetUserId: "91003", tier: "inactive_48h", followingRank: 1000 },
          { targetUserId: "91004", tier: "inactive_48h", followingRank: 1500 },
          { targetUserId: "91005", tier: "inactive_48h", followingRank: 1600 },
        ],
      });
      expect(imported.accepted).toEqual(["91001", "91002", "91003", "91004", "91005"]);
      expect(getDb().prepare("SELECT followed_at FROM unfollow_candidates WHERE target_user_id = '91002'").get()).toEqual({ followed_at: null });
      const saved = publicRead(1, [
        { id: "91001", verified: false, verified_type: "none", connection_status: ["following"] },
        { id: "91002", verified: true, verified_type: "blue", connection_status: ["following", "followed_by"], posts: [{ id: "p2", created_at: OLD_POST, text: "old" }] },
        { id: "91003", verified: true, verified_type: "blue", connection_status: ["following", "followed_by"], posts: [{ id: "p3", created_at: OLD_POST, text: "old" }] },
        { id: "91004", verified: true, verified_type: "blue", connection_status: ["following", "followed_by"] },
        { id: "91005", verified: true, verified_type: "blue", connection_status: ["following", "followed_by"], posts: [{ id: "p5", created_at: EXACT_48H, text: "boundary" }] },
      ]);
      expect(saved.activityWindowComplete).toBe(false);

      const batch = await submitUnfollowBatch({ accountId: 1, now: NOW });
      expect(batch.results.map((item) => item.targetUserId)).toEqual(["91001", "91002", "91003", "91004", "91005"]);
      expect(batch.results[0]).toMatchObject({ targetUserId: "91001", result: "success", reason: "non_blue" });
      expect(batch.results.find((item) => item.targetUserId === "91002")).toMatchObject({
        result: "success",
        reason: "inactive_48h_beyond_1000",
      });
      expect(batch.results.find((item) => item.targetUserId === "91003")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.results.find((item) => item.targetUserId === "91004")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.results.find((item) => item.targetUserId === "91005")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.unfollowed).toBe(2);
      expect(getDb().prepare("SELECT followed_at, status FROM unfollow_candidates WHERE target_user_id = '91002'").get()).toEqual({
        followed_at: null,
        status: "success",
      });
      expect(getDb().prepare("SELECT followed_at FROM unfollow_candidates WHERE target_user_id = '91003'").get()).toEqual({ followed_at: null });
      expect(seen.filter((item) => item.startsWith("GET"))).toEqual([]);
      expect(seen.filter((item) => item.startsWith("DELETE"))).toHaveLength(2);
      expect(UNFOLLOW_BATCH_LIMIT).toBe(10);
      expect(UNFOLLOW_WHITELIST.size).toBe(7);

      importUnfollowCandidates(2, {
        candidates: [{ targetUserId: "92001", tier: "inactive_48h", followingRank: 1001 }],
      });
      publicRead(2, [
        { id: "92001", verified: true, verified_type: "blue", connection_status: ["following", "followed_by"], posts: [{ id: "q", created_at: OLD_POST, text: "old" }] },
      ]);
      const account2 = await submitUnfollowBatch({ accountId: 2, now: NOW });
      expect(account2.results).toEqual([
        { targetUserId: "92001", tier: "inactive_48h", result: "unknown", reason: "follow_time_unknown" },
      ]);
      expect(account2.unfollowed).toBe(0);
      expect(seen.filter((item) => item.startsWith("GET"))).toEqual([]);
      expect(seen.filter((item) => item.startsWith("DELETE"))).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });
});
