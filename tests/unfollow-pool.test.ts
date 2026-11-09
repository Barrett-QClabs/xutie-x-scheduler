import { describe, expect, it } from "vitest";
import { GET as readCandidates } from "@/app/api/unfollow/candidates/route";
import { getDb, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { londonUnfollowSlot } from "@/lib/london";
import { importTweets, saveCredentials } from "@/lib/service";
import { ACCOUNT2_UNFOLLOW_WHITELIST, UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
import { UNFOLLOW_BATCH_LIMIT, UNFOLLOW_EVIDENCE_MAX_MS } from "@/lib/unfollow-policy";
import {
  importUnfollowCandidates,
  setUnfollowPaused,
  submitUnfollowBatch,
  unfollowEvidenceState,
} from "@/lib/unfollow-queue";

const SLOT = new Date("2026-11-09T00:20:00.000Z");
const NEXT = new Date("2026-11-09T00:50:00.000Z");
const LEDGER = "2026-11-06T00:00:00.000Z";

function enable(accountId: 1 | 2 = 1) {
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

function evidence(accountId: 1 | 2, id: string, observed: string, expires: string) {
  importEvidence(accountId, {
    schema_version: 1,
    account_id: accountId === 1 ? "1933586991612080128" : "1468479269701820422",
    source_namespace: accountId === 1 ? "user-X" : "user-X--english",
    source_tool: "get_users_me_following",
    observed_at: observed,
    expires_at: expires,
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects: [{
      id,
      verified: false,
      verified_type: "none",
      connection_status: ["following"],
    }],
  }, SLOT);
}

function success(accountId: 1 | 2, id: string, at: string) {
  getDb().prepare(
    `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
     VALUES (?, ?, 'kept', 'followback', ?, '2026-11-06T00:00', '2026-11-06')`,
  ).run(accountId, id, at);
}

describe("account 1 daily unfollow pool", () => {
  it("skips missing or expired evidence without closing the candidate", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    const previousMode = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      seen.push(`${method} ${String(input)}`);
      if (method === "DELETE") return new Response("{}", { status: 200 });
      throw new Error("network");
    };
    try {
      enable();
      const posted = importTweets({
        accountId: 1,
        source: "approved chinese post",
        format: "text",
        startAt: "2026-11-09T15:58:07.868Z",
        intervalMinutes: 15,
        randomMinSeconds: 0,
        randomMaxSeconds: 0,
      });
      importUnfollowCandidates(1, {
        candidates: [
          { targetUserId: "701", tier: "non_blue" },
          { targetUserId: "702", tier: "non_blue" },
        ],
      });
      evidence(1, "702", "2026-11-08T00:00:00.000Z", "2026-11-08T12:00:00.000Z");
      const first = await submitUnfollowBatch({ accountId: 1, now: SLOT });
      expect(first.slot).toBe("2026-11-09T00:15");
      expect(first.unfollowed).toBe(0);
      expect(first.submitted).toBe(0);
      expect(getDb().prepare("SELECT status, reason FROM unfollow_candidates WHERE target_user_id = '701'").get()).toEqual({
        status: "candidate",
        reason: "evidence_missing",
      });
      expect(getDb().prepare("SELECT status, reason FROM unfollow_candidates WHERE target_user_id = '702'").get()).toEqual({
        status: "candidate",
        reason: "evidence_expired",
      });
      const again = await submitUnfollowBatch({ accountId: 1, now: NEXT });
      expect(again.unfollowed).toBe(0);
      expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '701'").get()).toEqual({ status: "candidate" });

      const observed = new Date(SLOT.getTime() - 60 * 1000).toISOString();
      evidence(1, "701", observed, new Date(Date.parse(observed) + UNFOLLOW_EVIDENCE_MAX_MS).toISOString());
      expect(unfollowEvidenceState(1, "701", SLOT)).toBe("fresh");
      const acted = await submitUnfollowBatch({ accountId: 1, now: new Date("2026-11-09T01:20:00.000Z") });
      expect(acted.unfollowed).toBe(1);
      expect(acted.results[0]).toMatchObject({ targetUserId: "701", result: "success", reason: "non_blue" });
      expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '702'").get()).toEqual({ status: "candidate" });
      expect(seen.some((item) => item.startsWith("GET"))).toBe(false);
      expect(seen.filter((item) => item.startsWith("DELETE"))).toHaveLength(1);
      const tweet = getDb().prepare("SELECT text, scheduled_at FROM tweets WHERE account_id = 1").get();
      expect(tweet).toEqual({ text: "approved chinese post", scheduled_at: posted.queued[0].scheduledAt });
      expect(UNFOLLOW_BATCH_LIMIT).toBe(10);
      expect(UNFOLLOW_WHITELIST.size).toBe(7);
      expect(ACCOUNT2_UNFOLLOW_WHITELIST.size).toBe(0);
      expect(londonUnfollowSlot(new Date("2026-11-09T00:45:00.000Z"))).toBe("2026-11-09T00:45");
      expect(londonUnfollowSlot(new Date("2026-11-09T00:10:00.000Z"))).toBeNull();
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previousMode;
      delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
    }
  });

  it("clamps unfollow evidence at 25 hours and pages only this account", async () => {
    enable();
    const observed = "2026-11-08T00:00:00.000Z";
    const dayLater = new Date(Date.parse(observed) + 20 * 60 * 60 * 1000);
    evidence(1, "801", observed, new Date(Date.parse(observed) + 30 * 60 * 60 * 1000).toISOString());
    expect(unfollowEvidenceState(1, "801", dayLater)).toBe("fresh");
    expect(unfollowEvidenceState(1, "801", new Date(Date.parse(observed) + UNFOLLOW_EVIDENCE_MAX_MS + 1000))).toBe("expired");
    importUnfollowCandidates(1, {
      candidates: [
        { targetUserId: "801", tier: "non_blue" },
        { targetUserId: "802", tier: "non_blue" },
        { targetUserId: "803", tier: "non_blue" },
      ],
    });
    importUnfollowCandidates(2, { candidates: [{ targetUserId: "901", tier: "non_blue" }] });
    const page = await (await readCandidates(new Request("http://local/api/unfollow/candidates?accountId=1&limit=2"))).json();
    expect(page.candidates).toHaveLength(2);
    expect(page.candidates.map((item: { targetUserId: string }) => item.targetUserId)).toEqual(["803", "802"]);
    expect(page.nextBefore).toBe("802");
    expect(page.executable).toBe(0);
    const rest = await (await readCandidates(new Request("http://local/api/unfollow/candidates?accountId=1&limit=2&before=802"))).json();
    expect(rest.candidates.map((item: { targetUserId: string }) => item.targetUserId)).toEqual(["801"]);
    expect(rest.candidates[0].evidence).toBe("expired");
    expect(rest.executable).toBe(0);
    const other = await (await readCandidates(new Request("http://local/api/unfollow/candidates?accountId=2"))).json();
    expect(other.candidates.map((item: { targetUserId: string }) => item.targetUserId)).toEqual(["901"]);
    expect(other.executable).toBe(0);
  });

  it("fills 72h from the same account ledger and rejects a mismatched time", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    const previousMode = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      seen.push(`${method} ${String(input)}`);
      if (method === "DELETE") return new Response("{}", { status: 200 });
      throw new Error("network");
    };
    try {
      enable();
      enable(2);
      success(2, "711", LEDGER);
      const copied = importUnfollowCandidates(1, { candidates: [{ targetUserId: "711", tier: "no_followback_72h" }] });
      expect(copied.accepted).toEqual(["711"]);
      expect(getDb().prepare("SELECT followed_at FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = '711'").get()).toEqual({
        followed_at: null,
      });
      success(1, "712", LEDGER);
      const filled = importUnfollowCandidates(1, {
        candidates: [{ targetUserId: "712", tier: "no_followback_72h", firstRecordedAt: "2026-01-01T00:00:00.000Z" }],
      });
      expect(filled.accepted).toEqual(["712"]);
      expect(getDb().prepare("SELECT followed_at, first_recorded_at FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = '712'").get()).toEqual({
        followed_at: LEDGER,
        first_recorded_at: "2026-01-01T00:00:00.000Z",
      });
      const mismatch = importUnfollowCandidates(1, {
        candidates: [{ targetUserId: "712", tier: "no_followback_72h", followedAt: "2026-11-07T00:00:00.000Z" }],
      });
      expect(mismatch.rejected).toEqual([{ targetUserId: "712", reason: "followed_at_mismatch" }]);
      expect(getDb().prepare("SELECT followed_at FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = '712'").get()).toEqual({
        followed_at: LEDGER,
      });
      const matched = importUnfollowCandidates(1, {
        candidates: [{ targetUserId: "713", tier: "no_followback_72h", followedAt: LEDGER }],
      });
      expect(matched.rejected).toEqual([{ targetUserId: "713", reason: "followed_at_mismatch" }]);
      success(1, "713", LEDGER);
      const accepted = importUnfollowCandidates(1, {
        candidates: [{ targetUserId: "713", tier: "no_followback_72h", followedAt: LEDGER }],
      });
      expect(accepted.accepted).toEqual(["713"]);
      const none = importUnfollowCandidates(1, { candidates: [{ targetUserId: "714", tier: "no_followback_72h" }] });
      expect(none.accepted).toEqual(["714"]);
      expect(getDb().prepare("SELECT followed_at FROM unfollow_candidates WHERE target_user_id = '714'").get()).toEqual({ followed_at: null });

      evidence(1, "712", new Date(SLOT.getTime() - 60_000).toISOString(), new Date(SLOT.getTime() + 60 * 60 * 1000).toISOString());
      evidence(1, "714", new Date(SLOT.getTime() - 60_000).toISOString(), new Date(SLOT.getTime() + 60 * 60 * 1000).toISOString());
      const blueBack = {
        schema_version: 1,
        account_id: "1933586991612080128",
        source_namespace: "user-X",
        source_tool: "get_user",
        observed_at: new Date(SLOT.getTime() - 30_000).toISOString(),
        expires_at: new Date(SLOT.getTime() + 60 * 60 * 1000).toISOString(),
        request_fields: ["verified", "verified_type", "connection_status"],
        coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
        errors: [],
        subjects: [
          { id: "712", verified: true, verified_type: "blue", connection_status: ["following"], lang: "zh" },
          { id: "714", verified: true, verified_type: "blue", connection_status: ["following"], lang: "zh" },
        ],
      };
      importEvidence(1, blueBack, SLOT);
      const batch = await submitUnfollowBatch({ accountId: 1, now: SLOT });
      expect(batch.results.find((item) => item.targetUserId === "712")).toMatchObject({ result: "success", reason: "no_followback_72h" });
      expect(batch.results.find((item) => item.targetUserId === "714")).toMatchObject({ result: "unknown", reason: "follow_time_unknown" });
      expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '714'").get()).toEqual({ status: "unknown" });
      expect(getDb().prepare("SELECT succeeded_at FROM follow_success WHERE account_id = 2 AND target_user_id = '711'").get()).toEqual({
        succeeded_at: LEDGER,
      });
      expect(seen.some((item) => item.startsWith("GET"))).toBe(false);
      expect(seen.filter((item) => item.startsWith("DELETE"))).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previousMode;
      delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
      delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
    }
  });
});
