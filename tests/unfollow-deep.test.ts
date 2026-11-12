import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { saveCredentials } from "@/lib/service";
import { UNFOLLOW_BATCH_LIMIT, UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
import { importUnfollowCandidates, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";

const SLOT = new Date("2026-11-10T20:20:00.000Z");
const NOT_BACK = {
  following: true,
  blue: true,
  followsBack: false,
  lastPostAt: "2026-11-10T14:00:00.000Z",
  lastPostKnown: true,
};

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

function relationship(accountId: 1 | 2, ids: string[]) {
  importEvidence(accountId, {
    schema_version: 1,
    account_id: accountId === 1 ? "1933586991612080128" : "1468479269701820422",
    source_namespace: accountId === 1 ? "user-X" : "user-X--english",
    source_tool: "get_users_me_following",
    observed_at: "2026-11-10T14:00:00.000Z",
    expires_at: "2026-11-11T14:00:00.000Z",
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects: ids.map((id) => ({
      id,
      verified: true,
      verified_type: "blue",
      connection_status: ["following"],
    })),
  }, SLOT);
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("unfollow past the shallow thousand", () => {
  it("unfollows a page-41 candidate and keeps shallower or untimed people unknown", async () => {
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
          { targetUserId: "41001", tier: "no_followback_72h", followingPage: 41, firstRecordedAt: "2026-11-10T14:00:00.000Z" },
          { targetUserId: "41002", tier: "no_followback_72h" },
          { targetUserId: "41003", tier: "no_followback_72h", followingRank: 1000 },
          { targetUserId: "41004", tier: "no_followback_72h", followingPage: 40 },
        ],
      });
      expect(imported.accepted).toEqual(["41001", "41002", "41003", "41004"]);
      expect(getDb().prepare("SELECT followed_at, following_rank FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = '41001'").get()).toEqual({
        followed_at: null,
        following_rank: 1001,
      });
      expect(getDb().prepare("SELECT following_rank FROM unfollow_candidates WHERE target_user_id = '41003'").get()).toEqual({ following_rank: 1000 });
      expect(getDb().prepare("SELECT following_rank FROM unfollow_candidates WHERE target_user_id = '41004'").get()).toEqual({ following_rank: 976 });
      relationship(1, ["41001", "41002", "41003", "41004"]);
      const batch = await submitUnfollowBatch({ accountId: 1, now: SLOT });
      expect(batch.results.find((item) => item.targetUserId === "41001")).toMatchObject({
        result: "success",
        reason: "no_followback_beyond_1000",
      });
      expect(batch.results.find((item) => item.targetUserId === "41002")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.results.find((item) => item.targetUserId === "41003")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.results.find((item) => item.targetUserId === "41004")).toMatchObject({
        result: "unknown",
        reason: "follow_time_unknown",
      });
      expect(batch.unfollowed).toBe(1);
      expect(seen.filter((item) => item.startsWith("GET"))).toEqual([]);
      expect(seen.filter((item) => item.startsWith("DELETE"))).toHaveLength(1);
      expect(UNFOLLOW_BATCH_LIMIT).toBe(10);
      expect(UNFOLLOW_WHITELIST.size).toBe(7);

      const other = importUnfollowCandidates(2, {
        candidates: [{ targetUserId: "42001", tier: "no_followback_72h", followingRank: 1001 }],
      });
      expect(other.accepted).toEqual(["42001"]);
      expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = '42001'").get()).toBeUndefined();
      relationship(2, ["42001"]);
      const account2 = await submitUnfollowBatch({
        accountId: 2,
        now: SLOT,
        hooks: {
          inspect: async () => NOT_BACK,
          unfollow: async () => undefined,
        },
      });
      expect(account2.results[0]).toMatchObject({ targetUserId: "42001", result: "success", reason: "no_followback_beyond_1000" });
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("reopens an unknown row only when the new import is past rank 1000", async () => {
    const stamp = "2026-11-10T08:00:00.000Z";
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status, result, reason, created_at, updated_at)
       VALUES (1, '66001', NULL, 'no_followback_72h', NULL, NULL, NULL, 'unknown', 'unknown', 'follow_time_unknown', ?, ?)`,
    ).run(stamp, stamp);
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status, result, reason, created_at, updated_at)
       VALUES (1, '66002', NULL, 'no_followback_72h', NULL, NULL, NULL, 'unknown', 'unknown', 'follow_time_unknown', ?, ?)`,
    ).run(stamp, stamp);
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status, result, reason, created_at, updated_at)
       VALUES (1, '66003', NULL, 'non_blue', NULL, NULL, NULL, 'success', 'success', 'non_blue', ?, ?)`,
    ).run(stamp, stamp);

    const still = importUnfollowCandidates(1, { candidates: [{ targetUserId: "66001", tier: "no_followback_72h", followingRank: 1000 }] });
    expect(still.existing).toEqual(["66001"]);
    expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '66001'").get()).toEqual({ status: "unknown" });

    const opened = importUnfollowCandidates(1, { candidates: [{ targetUserId: "66001", tier: "no_followback_72h", followingPage: 41 }] });
    expect(opened.reopened).toEqual(["66001"]);
    expect(getDb().prepare("SELECT status, followed_at, following_rank, reason FROM unfollow_candidates WHERE target_user_id = '66001'").get()).toEqual({
      status: "candidate",
      followed_at: null,
      following_rank: 1001,
      reason: null,
    });
    const untouched = importUnfollowCandidates(1, { candidates: [{ targetUserId: "66002", tier: "no_followback_72h" }] });
    expect(untouched.existing).toEqual(["66002"]);
    const kept = importUnfollowCandidates(1, { candidates: [{ targetUserId: "66003", tier: "non_blue", followingRank: 5000 }] });
    expect(kept.existing).toEqual(["66003"]);
    expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '66003'").get()).toEqual({ status: "success" });
  });
});
