import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { account1FollowbackDeadline } from "@/lib/follow-cadence";
import { getFollowStatus, stockFollowReserve, submitFollowBatch } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";
import { unfollowEvidenceState } from "@/lib/unfollow-queue";
import { UNFOLLOW_EVIDENCE_MAX_MS } from "@/lib/unfollow-policy";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";

const ACCOUNT = "1933586991612080128";
const CHECKED = "2026-11-14T15:00:00.000Z";
const EXPIRES = "2026-11-15T01:00:00.000Z";

function taipei(hour: number, minute: number, day = "2026-11-15"): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
}

function enable(accountId: 1 | 2) {
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW"] = "on";
  saveCredentials(accountId, {
    apiKey: accountId === 1 ? "acctoneA" : "accttwoB",
    apiSecret: "slot-secret-value",
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(accountId, accountId === 1
    ? { username: "barrett_tt", displayName: "Barrett", userId: ACCOUNT }
    : { username: "boylittle18", displayName: "Boy", userId: "1468479269701820422" });
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function evidence(id: string, expires = EXPIRES, observed = CHECKED) {
  importEvidence(1, {
    schema_version: 1,
    account_id: ACCOUNT,
    source_namespace: "user-X",
    source_tool: "get_users_me_followers",
    observed_at: observed,
    expires_at: expires,
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects: [{
      id,
      username: "fan",
      name: "中文名",
      description: "回关",
      verified: true,
      verified_type: "blue",
      connection_status: ["followed_by"],
    }],
  }, taipei(23, 0, "2026-11-14"));
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("account 1 follow-back overnight hold", () => {
  it("uses a 23:00 check through the next 00:00–05:00 window and leaves the timestamp alone", async () => {
    enable(1);
    const ids = Array.from({ length: 14 }, (_, index) => String(81000 + index));
    for (const id of ids) evidence(id);
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: ids.map((id) => ({ targetUserId: id, kind: "followback" as const })),
    }, taipei(23, 0, "2026-11-14"));
    stockFollowReserve(1, {
      checkedAt: "2026-11-13T15:00:00.000Z",
      candidates: [{ targetUserId: "81999", kind: "followback" }],
    }, taipei(23, 0, "2026-11-14"));
    expect(account1FollowbackDeadline(CHECKED)).toBe(taipei(5, 0).getTime());
    const follows: string[] = [];
    const fetches: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      fetches.push(String(input));
      throw new Error("network");
    };
    const hooks = {
      inspect: async (id: string) => {
        const { evidenceFollowProfile } = await import("@/lib/evidence");
        return evidenceFollowProfile(1, id, taipei(0, 5));
      },
      follow: async (id: string) => { follows.push(id); },
    };
    try {
      expect(getFollowStatus(1, taipei(0, 5)).reserve.followbackAvailable).toBe(14);
      const first = await submitFollowBatch({ accountId: 1, now: taipei(0, 5), hooks });
      expect(first.slot).toBe("taipei:2026-11-15T00:00");
      expect(first.followed).toBe(13);
      expect(first.results.every((item) => item.kind === "followback" && item.reason === "followback")).toBe(true);
      const mid = await submitFollowBatch({
        accountId: 1,
        now: taipei(2, 12),
        hooks: {
          inspect: async (id) => {
            const { evidenceFollowProfile } = await import("@/lib/evidence");
            return evidenceFollowProfile(1, id, taipei(2, 12));
          },
          follow: async (id) => { follows.push(id); },
        },
      });
      expect(mid.slot).toBe("taipei:2026-11-15T02:12");
      expect(mid.followed).toBe(1);
      const late = await submitFollowBatch({
        accountId: 1,
        now: taipei(4, 57),
        hooks: {
          inspect: async () => { throw new Error("none left"); },
          follow: async () => { throw new Error("none left"); },
        },
      });
      expect(late.followed).toBe(0);
      expect(late.reason).toBe("stale_reserve");
      expect(getDb().prepare("SELECT status, checked_at FROM follow_reserve WHERE target_user_id = '81999'").get()).toEqual({
        status: "reserved",
        checked_at: "2026-11-13T15:00:00.000Z",
      });
      const closed = await submitFollowBatch({
        accountId: 1,
        now: taipei(5, 0),
        hooks: { inspect: async () => { throw new Error("closed"); }, follow: async () => { throw new Error("closed"); } },
      });
      expect(closed.reason).toBe("rest");
      expect(follows).toHaveLength(14);
      expect(follows).not.toContain("81999");
      expect(fetches).toEqual([]);
      const stored = getDb().prepare(
        "SELECT checked_at FROM follow_reserve WHERE target_user_id = '81000'",
      ).get() as { checked_at: string };
      expect(stored.checked_at).toBe(CHECKED);
      const replay = await submitFollowBatch({
        accountId: 1,
        now: taipei(0, 10),
        hooks: { inspect: async () => { throw new Error("replay"); }, follow: async () => { throw new Error("replay"); } },
      });
      expect(replay.replay).toBe(true);
      expect(replay.followed).toBe(13);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not follow when the cached evidence has expired", async () => {
    enable(1);
    evidence("82001", "2026-11-14T15:30:00.000Z");
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: [{ targetUserId: "82001", kind: "followback" }],
    }, taipei(23, 0, "2026-11-14"));
    const follows: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 5),
      hooks: {
        inspect: async (id) => {
          const { evidenceFollowProfile } = await import("@/lib/evidence");
          return evidenceFollowProfile(1, id, taipei(0, 5));
        },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(follows).toEqual([]);
    expect(batch.results[0]).toMatchObject({ result: "unknown", reason: "blue_unconfirmed" });
    expect(getDb().prepare("SELECT checked_at FROM follow_reserve WHERE target_user_id = '82001'").get()).toEqual({
      checked_at: CHECKED,
    });
  });

  it("stops account 1 follow-back on 429 and leaves account 2 on the 45-minute gate", async () => {
    enable(1);
    enable(2);
    evidence("83001");
    evidence("83002");
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: [
        { targetUserId: "83001", kind: "followback" },
        { targetUserId: "83002", kind: "followback" },
        { targetUserId: [...UNFOLLOW_WHITELIST][0], kind: "followback" },
      ],
    }, taipei(23, 0, "2026-11-14"));
    evidence([...UNFOLLOW_WHITELIST][0]);
    const follows: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 5),
      hooks: {
        inspect: async (id) => {
          const { evidenceFollowProfile } = await import("@/lib/evidence");
          return evidenceFollowProfile(1, id, taipei(0, 5));
        },
        follow: async (id) => {
          follows.push(id);
          throw Object.assign(new Error("limited"), { status: 429, kind: "rate_limit" });
        },
      },
    });
    expect(batch.results.map((item) => item.reason)).toContain("whitelist");
    expect(batch.results.filter((item) => item.reason === "rate_limit")).toHaveLength(1);
    expect(follows).toHaveLength(1);
    expect(getDb().prepare("SELECT paused, pause_reason FROM follow_control WHERE account_id = 1").get()).toEqual({
      paused: 1,
      pause_reason: "rate_limit",
    });
    expect(getDb().prepare("SELECT paused FROM follow_control WHERE account_id = 2").get()).toEqual({ paused: 0 });
    stockFollowReserve(2, {
      checkedAt: new Date(taipei(0, 5).getTime() - 3 * 60 * 60 * 1000).toISOString(),
      candidates: [{ targetUserId: "83099", kind: "followback" }],
    }, taipei(0, 5));
    const other = await submitFollowBatch({
      accountId: 2,
      now: taipei(0, 5),
      hooks: { inspect: async () => { throw new Error("account2"); }, follow: async () => { throw new Error("account2"); } },
    });
    expect(other.reason).toBe("stale_reserve");
    expect(other.followed).toBe(0);
  });

  it("keeps 23:00 unfollow evidence fresh at 09:00 and still clamps it at 25 hours", () => {
    const observed = Date.parse(CHECKED);
    const morning = observed + 10 * 60 * 60 * 1000;
    expect(morning - observed).toBeLessThan(UNFOLLOW_EVIDENCE_MAX_MS);
    importEvidence(1, {
      schema_version: 1,
      account_id: ACCOUNT,
      source_namespace: "user-X",
      source_tool: "get_users_me_following",
      observed_at: CHECKED,
      expires_at: new Date(observed + 24 * 60 * 60 * 1000).toISOString(),
      request_fields: ["connection_status", "verified", "verified_type"],
      coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
      errors: [],
      subjects: [{ id: "84001", verified: false, verified_type: "none", connection_status: ["following"] }],
    });
    expect(unfollowEvidenceState(1, "84001", new Date(morning))).toBe("fresh");
    expect(unfollowEvidenceState(1, "84001", new Date(observed + UNFOLLOW_EVIDENCE_MAX_MS + 1000))).toBe("expired");
    const row = getDb().prepare("SELECT observed_at, expires_at FROM evidence_subjects WHERE target_user_id = '84001'").get() as {
      observed_at: string;
      expires_at: string;
    };
    expect(row.observed_at).toBe(CHECKED);
    expect(Date.parse(row.expires_at) - observed).toBe(24 * 60 * 60 * 1000);
  });
});
