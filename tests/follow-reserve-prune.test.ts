import { describe, expect, it } from "vitest";
import { GET as readAudit } from "@/app/api/follow/reserve/audit/route";
import { POST as pruneReserve } from "@/app/api/follow/reserve/prune/route";
import { GET as readFollow } from "@/app/api/follow/route";
import { ACCOUNT1_KEYWORDS } from "@/lib/follow-config";
import { getDb } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { pruneActiveReserve, stockFollowReserve } from "@/lib/follow-queue";
import { londonFollowSlot } from "@/lib/london";
import { FOLLOW_DAILY_CAP } from "@/lib/unfollow-policy";
import { importTweets } from "@/lib/service";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const STALE = "2026-11-09T08:00:00.000Z";
const CREATED = "2026-11-09T07:00:00.000Z";

function insertReserved(accountId: 1 | 2, id: string, kind: "new" | "followback", checkedAt = STALE) {
  getDb().prepare(
    `INSERT INTO follow_reserve
      (account_id, target_user_id, username, kind, status, checked_at, followers_count, last_post_at, prefer_flb, result, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'reserved', ?, 120, NULL, 0, NULL, NULL, ?, ?)`,
  ).run(accountId, id, `u${id}`, kind, checkedAt, CREATED, CREATED);
}

function qualifiedEvidence(id: string) {
  importEvidence(2, {
    schema_version: 1,
    account_id: "1468479269701820422",
    source_namespace: "user-X--english",
    source_tool: "get_users_me_followers",
    observed_at: "2026-11-09T11:50:00.000Z",
    expires_at: "2026-11-09T12:40:00.000Z",
    request_fields: ["verified", "verified_type", "connection_status", "lang"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects: [{
      id,
      username: "ada",
      name: "Ada",
      description: "hello",
      lang: "en",
      verified: true,
      verified_type: "blue",
      connection_status: ["followed_by"],
    }],
  }, NOW);
}

async function prune(body: Record<string, unknown>) {
  return pruneReserve(new Request("http://local/api/follow/reserve/prune", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

describe("follow reserve prune", () => {
  it("parks account 2's fifteen new rows and leaves the other account untouched", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      throw new Error("network");
    };
    try {
      const posted = importTweets({
        accountId: 2,
        source: "approved english post",
        format: "text",
        startAt: "2026-11-09T16:00:00.000Z",
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      const fresh = new Date().toISOString();
      for (let index = 0; index < 15; index += 1) insertReserved(2, String(82001 + index), "new");
      insertReserved(2, "83001", "followback", fresh);
      insertReserved(1, "81001", "new", fresh);
      insertReserved(1, "81002", "new", fresh);
      getDb().prepare(
        `INSERT INTO follow_reserve
          (account_id, target_user_id, username, kind, status, checked_at, followers_count, last_post_at, prefer_flb, result, reason, created_at, updated_at)
         VALUES (2, '84001', 'failed-user', 'new', 'failed', ?, NULL, NULL, 0, 'failed', 'action_failed', ?, ?)`,
      ).run(STALE, CREATED, CREATED);
      getDb().prepare(
        `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
         VALUES (2, '85001', 'kept', 'followback', ?, '2026-11-09T12:00', '2026-11-09')`,
      ).run(NOW.toISOString());
      const keywordsBefore = getDb().prepare("SELECT keywords_json FROM follow_account_config WHERE account_id = 1").get();

      const forged = await prune({ accountId: 2, kinds: ["new"], statuses: ["reserved"], reason: "spam" });
      expect(forged.status).toBe(400);
      expect((await forged.json()).code).toBe("forged_reason");
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 2 AND kind = 'new' AND status = 'reserved'").get()).toEqual({ n: 15 });

      const response = await prune({ accountId: 2, kinds: ["new"], statuses: ["reserved"], reason: "hold_new" });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.applied).toBe(true);
      expect(body.parked).toHaveLength(15);
      expect(body.active).toBe(1);
      expect(body.newAvailable).toBe(0);
      expect(body.followbackAvailable).toBe(1);
      expect(body.parked.every((item: { parkedReason: string; evidenceReason: string; kind: string }) => item.parkedReason === "hold_new" && item.evidenceReason === "blue_unconfirmed" && item.kind === "new")).toBe(true);
      expect(JSON.stringify(body)).not.toContain("not_blue");
      expect(JSON.stringify(body)).not.toContain("spam");

      const onlyNew = getDb().prepare(
        "SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 2 AND status = 'reserved' AND kind = 'new'",
      ).get() as { n: number };
      expect(onlyNew.n).toBe(0);
      const followback = getDb().prepare(
        "SELECT status, kind FROM follow_reserve WHERE account_id = 2 AND target_user_id = '83001'",
      ).get();
      expect(followback).toEqual({ status: "reserved", kind: "followback" });
      const account1 = getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get() as { n: number };
      expect(account1.n).toBe(2);
      const failed = getDb().prepare(
        "SELECT status, result, reason FROM follow_reserve WHERE account_id = 2 AND target_user_id = '84001'",
      ).get();
      expect(failed).toEqual({ status: "failed", result: "failed", reason: "action_failed" });
      const success = getDb().prepare(
        "SELECT username, kind, succeeded_at FROM follow_success WHERE account_id = 2 AND target_user_id = '85001'",
      ).get();
      expect(success).toEqual({ username: "kept", kind: "followback", succeeded_at: NOW.toISOString() });
      expect(getDb().prepare("SELECT keywords_json FROM follow_account_config WHERE account_id = 1").get()).toEqual(keywordsBefore);
      const tweet = getDb().prepare("SELECT text, scheduled_at, status FROM tweets WHERE account_id = 2").get();
      expect(tweet).toEqual({ text: "approved english post", scheduled_at: posted.queued[0].scheduledAt, status: "pending" });

      const audit = await (await readAudit(new Request("http://local/api/follow/reserve/audit?accountId=2&limit=50"))).json();
      expect(audit.entries).toHaveLength(15);
      const sample = audit.entries.find((item: { targetUserId: string }) => item.targetUserId === "82001");
      expect(sample).toMatchObject({
        kind: "new",
        checkedAt: STALE,
        createdAt: CREATED,
        updatedAt: CREATED,
        priorStatus: "reserved",
        priorReason: null,
        parkedReason: "hold_new",
        evidenceReason: "blue_unconfirmed",
        terminal: false,
      });
      const otherAudit = await (await readAudit(new Request("http://local/api/follow/reserve/audit?accountId=1&limit=50"))).json();
      expect(otherAudit.entries).toEqual([]);

      const account1Prune = await prune({ accountId: 1, kinds: ["new"], statuses: ["reserved"], reason: "hold_new" });
      const account1Body = await account1Prune.json();
      expect(account1Body.parked.map((item: { targetUserId: string }) => item.targetUserId).sort()).toEqual(["81001", "81002"]);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 2 AND target_user_id = '83001'").get()).toEqual({ n: 1 });
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve_audit WHERE account_id = 2").get()).toEqual({ n: 15 });
      expect(seen).toEqual([]);
      expect(FOLLOW_DAILY_CAP).toBe(380);
      expect(londonFollowSlot(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08T00:00");
      expect(londonFollowSlot(new Date("2026-11-08T00:45:00.000Z"))).toBeNull();
      expect(ACCOUNT1_KEYWORDS).toContain("人工智能");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports zero available and new counts after the fifteen new rows are the whole pool", async () => {
    for (let index = 0; index < 15; index += 1) insertReserved(2, String(82101 + index), "new");
    const response = await prune({ accountId: 2, kinds: ["new"], statuses: ["reserved"], reason: "hold_new" });
    const body = await response.json();
    expect(body.active).toBe(0);
    expect(body.newAvailable).toBe(0);
    expect(body.followbackAvailable).toBe(0);
    const status = await (await readFollow(new Request("http://local/api/follow?accountId=2"))).json();
    expect(status.reserve.available).toBe(0);
    expect(status.reserve.newAvailable).toBe(0);
    expect(status.dailyCap).toBe(380);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get()).toEqual({ n: 0 });
  });

  it("lets a fresh qualified candidate return and refuses to wash success or failure", () => {
    insertReserved(2, "82201", "new");
    const parked = pruneActiveReserve(2, { kinds: ["new"], statuses: ["reserved"], reason: "hold_new" }, NOW);
    expect(parked.newAvailable).toBe(0);
    const blocked = stockFollowReserve(2, {
      checkedAt: NOW.toISOString(),
      candidates: [{ targetUserId: "82201", kind: "new" }],
    }, NOW);
    expect(blocked.accepted).toEqual([]);
    expect(blocked.rejected).toEqual([{ targetUserId: "82201", reason: "blue_unconfirmed" }]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE target_user_id = '82201'").get()).toEqual({ n: 0 });

    qualifiedEvidence("82201");
    const returned = stockFollowReserve(2, {
      checkedAt: NOW.toISOString(),
      candidates: [{ targetUserId: "82201", kind: "new" }],
    }, NOW);
    expect(returned.accepted).toEqual(["82201"]);
    const active = getDb().prepare(
      "SELECT status, kind FROM follow_reserve WHERE account_id = 2 AND target_user_id = '82201'",
    ).get();
    expect(active).toEqual({ status: "reserved", kind: "new" });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve_audit WHERE account_id = 2 AND target_user_id = '82201'").get()).toEqual({ n: 1 });

    getDb().prepare(
      `INSERT INTO follow_reserve
        (account_id, target_user_id, username, kind, status, checked_at, followers_count, last_post_at, prefer_flb, result, reason, created_at, updated_at)
       VALUES (2, '82202', 'failed-user', 'new', 'failed', ?, NULL, NULL, 0, 'failed', 'action_failed', ?, ?)`,
    ).run(STALE, CREATED, CREATED);
    getDb().prepare(
      `INSERT INTO follow_reserve
        (account_id, target_user_id, username, kind, status, checked_at, followers_count, last_post_at, prefer_flb, result, reason, created_at, updated_at)
       VALUES (2, '82204', 'unknown-user', 'new', 'unknown', ?, NULL, NULL, 0, 'unknown', 'following_unconfirmed', ?, ?)`,
    ).run(STALE, CREATED, CREATED);
    getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (2, '82203', 'kept', 'new', ?, '2026-11-09T12:00', '2026-11-09')`,
    ).run(NOW.toISOString());
    qualifiedEvidence("82202");
    qualifiedEvidence("82203");
    qualifiedEvidence("82204");
    const washed = stockFollowReserve(2, {
      checkedAt: NOW.toISOString(),
      candidates: [
        { targetUserId: "82202", kind: "new" },
        { targetUserId: "82203", kind: "new" },
        { targetUserId: "82204", kind: "new" },
      ],
    }, NOW);
    expect(washed.accepted).toEqual([]);
    expect(washed.existing).toEqual(["82202", "82204"]);
    expect(washed.rejected).toEqual([{ targetUserId: "82203", reason: "already_followed" }]);
    expect(getDb().prepare("SELECT status, result, reason FROM follow_reserve WHERE target_user_id = '82202'").get()).toEqual({
      status: "failed",
      result: "failed",
      reason: "action_failed",
    });
    expect(getDb().prepare("SELECT status, result, reason FROM follow_reserve WHERE target_user_id = '82204'").get()).toEqual({
      status: "unknown",
      result: "unknown",
      reason: "following_unconfirmed",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE account_id = 2 AND target_user_id = '82203'").get()).toEqual({ n: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get()).toEqual({ n: 0 });
  });
});
