import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import { evidenceFollowProfile, importEvidence, readEvidence } from "@/lib/evidence";
import { followBatchLimit, followSlot } from "@/lib/follow-cadence";
import { stockFollowReserve, submitFollowBatch } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

const ACCOUNT1 = "1933586991612080128";
const ACCOUNT2 = "1468479269701820422";
const EVENING = taipei(18, 5);
const NEXT_ROUND = taipei(18, 35);

function taipei(hour: number, minute: number): Date {
  const asUtc = Date.parse(`2026-11-12T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  return new Date(asUtc - 8 * 60 * 60 * 1000);
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
    ? { username: "barrett_tt", displayName: "Barrett", userId: ACCOUNT1 }
    : { username: "boylittle18", displayName: "Boy", userId: ACCOUNT2 });
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function user(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    username: "xinren",
    name: "中文名",
    description: "人工智能",
    verified: true,
    verified_type: "blue",
    lang: "zh",
    ...over,
  };
}

function envelope(accountId: 1 | 2, tool: string, subjects: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    account_id: accountId === 1 ? ACCOUNT1 : ACCOUNT2,
    source_namespace: accountId === 1 ? "user-X" : "user-X--english",
    source_tool: tool,
    observed_at: "2026-11-12T10:00:00.000Z",
    expires_at: "2026-11-12T10:40:00.000Z",
    request_fields: ["id", "username", "name", "description", "verified", "verified_type", "connection_status", "lang"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    evidence_refs: ["search_users:connection_status"],
    subjects,
    ...over,
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("account 1 search_users relationship omission", () => {
  it("follows a new blue account when connection_status was requested and omitted", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      throw new Error("network");
    };
    try {
      enable(1);
      importEvidence(1, envelope(1, "search_users", [user("91001"), user("91002", { connection_status: ["following"] })]));
      importEvidence(1, envelope(1, "get_user", [user("91003")]));
      const stored = getDb().prepare(
        `SELECT source_tool, connection_status_json, connection_explicit, connection_omission_empty, raw_json
         FROM evidence_subjects WHERE account_id = 1 AND target_user_id = '91001'`,
      ).get() as {
        source_tool: string;
        connection_status_json: string | null;
        connection_explicit: number;
        connection_omission_empty: number;
        raw_json: string;
      };
      expect(stored.source_tool).toBe("search_users");
      expect(stored.connection_status_json).toBeNull();
      expect(stored.connection_explicit).toBe(0);
      expect(stored.connection_omission_empty).toBe(1);
      expect(stored.raw_json).not.toContain("connection_status");

      const seen = readEvidence(1, "91001", EVENING);
      expect(seen).toMatchObject({
        sourceTool: "search_users",
        following: false,
        followsBack: false,
        connectionExplicit: false,
        connectionOmission: true,
        blue: true,
      });
      expect(readEvidence(1, "91003", EVENING)?.following).toBeNull();

      stockFollowReserve(1, {
        checkedAt: "2026-11-12T10:00:00.000Z",
        candidates: [
          { targetUserId: "91001", username: "xinren", kind: "new" },
          { targetUserId: "91002", username: "xinren", kind: "new" },
          { targetUserId: "91003", username: "xinren", kind: "new" },
          { targetUserId: "91004", username: "xinren", kind: "followback" },
        ],
      }, EVENING);
      const batch = await submitFollowBatch({
        accountId: 1,
        now: EVENING,
        hooks: {
          inspect: async (id) => evidenceFollowProfile(1, id, EVENING),
          follow: async (id) => { calls.push(id); },
        },
      });
      expect(batch.slot).toBe("taipei-new:2026-11-12T18:00");
      expect(batch.followed).toBe(1);
      expect(calls).toEqual(["91001"]);
      expect(batch.results.find((item) => item.targetUserId === "91002")).toMatchObject({ result: "skipped", reason: "already_following" });
      expect(batch.results.find((item) => item.targetUserId === "91003")).toMatchObject({ result: "unknown", reason: "following_unconfirmed" });
      expect(batch.results.map((item) => item.targetUserId)).not.toContain("91004");
      expect(calls.some((item) => item.includes("api.x.com"))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps a search_users subject unknown when connection_status was not requested", () => {
    enable(1);
    importEvidence(1, envelope(1, "search_users", [user("91011")], {
      request_fields: ["id", "username", "verified", "verified_type", "lang"],
    }));
    const row = getDb().prepare(
      "SELECT connection_omission_empty FROM evidence_subjects WHERE account_id = 1 AND target_user_id = '91011'",
    ).get() as { connection_omission_empty: number };
    expect(row.connection_omission_empty).toBe(0);
    expect(readEvidence(1, "91011", EVENING)?.following).toBeNull();
  });

  it("reopens only an account 1 following_unconfirmed row after qualifying search_users evidence", async () => {
    enable(1);
    enable(2);
    importEvidence(1, envelope(1, "get_user", [user("91021")]));
    stockFollowReserve(1, {
      checkedAt: "2026-11-12T10:00:00.000Z",
      candidates: [{ targetUserId: "91021", kind: "new" }],
    }, EVENING);
    const calls: string[] = [];
    const first = await submitFollowBatch({
      accountId: 1,
      now: EVENING,
      hooks: {
        inspect: async (id) => evidenceFollowProfile(1, id, EVENING),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(first.results).toEqual([expect.objectContaining({ targetUserId: "91021", result: "unknown", reason: "following_unconfirmed" })]);

    const stuck = stockFollowReserve(1, {
      checkedAt: "2026-11-12T10:20:00.000Z",
      candidates: [{ targetUserId: "91021", kind: "new" }],
    }, NEXT_ROUND);
    expect(stuck.existing).toEqual(["91021"]);
    expect(stuck.refreshed).toEqual([]);

    importEvidence(1, envelope(1, "search_users", [user("91021")], {
      observed_at: "2026-11-12T10:20:00.000Z",
      expires_at: "2026-11-12T11:00:00.000Z",
    }));
    const reopened = stockFollowReserve(1, {
      checkedAt: "2026-11-12T10:20:00.000Z",
      candidates: [{ targetUserId: "91021", kind: "new" }],
    }, NEXT_ROUND);
    expect(reopened.refreshed).toEqual(["91021"]);
    const second = await submitFollowBatch({
      accountId: 1,
      now: NEXT_ROUND,
      hooks: {
        inspect: async (id) => evidenceFollowProfile(1, id, NEXT_ROUND),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(second.slot).toBe("taipei-new:2026-11-12T18:35");
    expect(second.followed).toBe(1);
    expect(calls).toEqual(["91021"]);

    getDb().prepare(
      `INSERT INTO follow_reserve
        (account_id, target_user_id, username, kind, status, checked_at, result, reason, created_at, updated_at)
       VALUES (2, '91022', 'ada', 'new', 'unknown', ?, 'unknown', 'following_unconfirmed', ?, ?)`,
    ).run("2026-11-12T10:00:00.000Z", "2026-11-12T10:00:00.000Z", "2026-11-12T10:05:00.000Z");
    importEvidence(2, envelope(2, "search_users", [{
      id: "91022",
      username: "ada",
      name: "Ada",
      description: "hello",
      verified: true,
      verified_type: "blue",
      lang: "en",
      connection_status: [],
    }]));
    const account2 = stockFollowReserve(2, {
      checkedAt: "2026-11-12T10:20:00.000Z",
      candidates: [{ targetUserId: "91022", kind: "new" }],
    }, NEXT_ROUND);
    expect(account2.existing).toEqual(["91022"]);
    expect(account2.refreshed).toEqual([]);
    expect(getDb().prepare("SELECT status, reason FROM follow_reserve WHERE account_id = 2 AND target_user_id = '91022'").get()).toEqual({
      status: "unknown",
      reason: "following_unconfirmed",
    });
  });
});

describe("account 2 is unchanged by search_users omission", () => {
  it("still treats a missing connection_status as unknown and keeps the evening cadence", async () => {
    expect(followSlot(2, EVENING)).toBe("taipei:2026-11-12T18:00");
    expect(followBatchLimit(2, EVENING)).toBe(10);
    expect(followSlot(1, EVENING)).toBe("taipei-new:2026-11-12T18:00");
    expect(followBatchLimit(1, EVENING)).toBe(9);
    enable(2);
    importEvidence(2, envelope(2, "search_users", [{
      id: "92001",
      username: "ada",
      name: "Ada",
      description: "hello",
      verified: true,
      verified_type: "blue",
      lang: "en",
    }]));
    const row = getDb().prepare(
      "SELECT connection_omission_empty, connection_status_json, source_tool FROM evidence_subjects WHERE account_id = 2 AND target_user_id = '92001'",
    ).get() as { connection_omission_empty: number; connection_status_json: string | null; source_tool: string };
    expect(row).toEqual({ connection_omission_empty: 0, connection_status_json: null, source_tool: "search_users" });
    expect(readEvidence(2, "92001", EVENING)?.following).toBeNull();
    expect(readEvidence(2, "92001", EVENING)?.connectionOmission).toBe(false);
    stockFollowReserve(2, {
      checkedAt: "2026-11-12T10:00:00.000Z",
      candidates: [{ targetUserId: "92001", kind: "new" }],
    }, EVENING);
    const calls: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 2,
      now: EVENING,
      hooks: {
        inspect: async (id) => evidenceFollowProfile(2, id, EVENING),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(batch.executed).toBe(true);
    expect(batch.followed).toBe(0);
    expect(batch.results).toEqual([expect.objectContaining({ targetUserId: "92001", result: "unknown", reason: "following_unconfirmed" })]);
    expect(calls).toEqual([]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get()).toEqual({ n: 0 });
  });
});
