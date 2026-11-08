import { describe, expect, it } from "vitest";
import { GET as legacyConfig } from "@/app/api/automation/config/route";
import { GET as legacyStatus } from "@/app/api/automation/route";
import { PUT as saveFollowConfig, GET as readFollowConfig } from "@/app/api/follow/config/route";
import { getDb } from "@/lib/db";
import { importEvidence, readEvidence } from "@/lib/evidence";
import { ACCOUNT1_KEYWORDS, ACCOUNT2_KEYWORDS } from "@/lib/follow-config";
import { classifyAction } from "@/lib/unfollow-queue";
import { xGet } from "@/lib/x-client";
import { runDueAutomation } from "@/lib/automation-run";
import { submitFollowBatch } from "@/lib/follow-queue";
import { londonFollowSlot, londonUnfollowSlot } from "@/lib/london";

const OBSERVED = "2026-11-08T07:50:00.000Z";
const EXPIRES = "2026-11-08T08:30:00.000Z";

function englishEnvelope(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    account_id: "1468479269701820422",
    source_namespace: "x",
    source_tool: "search_posts_all",
    observed_at: OBSERVED,
    expires_at: EXPIRES,
    request_fields: ["lang", "created_at", "text"],
    coverage: { pagination_complete: false, next_token: "more", activity_window_complete: true, excluded: [], window: { from: OBSERVED, to: EXPIRES } },
    errors: [],
    evidence_refs: ["english-sample"],
    subjects: [{
      id: "777",
      query: "lang:en",
      posts: [{ id: "p", created_at: "2026-11-08T07:40:00.000Z", text: "hello" }],
    }],
    ...over,
  };
}

describe("english free-read compatibility", () => {
  it("keeps the raw public tool and does not file it on account 1", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      throw new Error("network");
    };
    try {
      expect(() => importEvidence(1, englishEnvelope())).toThrow(/不属于这个槽/);
      const saved = importEvidence(2, englishEnvelope());
      expect(saved.sourceTool).toBe("search_posts_all");
      expect(saved.actualSourceNamespace).toBe("x");
      expect(saved.normalizedSource).toBe("public");
      expect(saved.activityWindowComplete).toBe(false);
      expect(saved.claimedActivityWindowComplete).toBe(true);
      const row = getDb().prepare(
        "SELECT source_tool, actual_source_namespace, source_namespace, normalized_source, tweet_lang, activity_window_complete, claimed_activity_window_complete FROM evidence_subjects WHERE account_id = 2 AND target_user_id = '777'",
      ).get() as { source_tool: string; actual_source_namespace: string; source_namespace: string; normalized_source: string; tweet_lang: string | null; activity_window_complete: number; claimed_activity_window_complete: number };
      expect(row.source_tool).toBe("search_posts_all");
      expect(row.actual_source_namespace).toBe("x");
      expect(row.source_namespace).toBe("x");
      expect(row.normalized_source).toBe("public");
      expect(row.tweet_lang).toBeNull();
      expect(row.activity_window_complete).toBe(0);
      expect(row.claimed_activity_window_complete).toBe(1);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_subjects WHERE account_id = 1 AND target_user_id = '777'").get()).toMatchObject({ n: 0 });
      const seen = readEvidence(2, "777", new Date("2026-11-08T08:00:00.000Z"));
      expect(seen?.tweetLang).toBeNull();
      expect(seen?.activityWindowComplete).toBe(false);
      expect(seen?.lastPostAt).toBe("2026-11-08T07:40:00.000Z");
      const decision = classifyAction({
        followedAt: null,
        fresh: { following: true, blue: true, followsBack: false, lastPostAt: seen?.lastPostAt ?? null, lastPostKnown: false },
        now: new Date("2026-11-08T08:00:00.000Z"),
        whitelisted: false,
      });
      expect(decision.proceed).toBe(false);
      await expect(xGet({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" }, "/2/users")).rejects.toThrow(/读额度|模拟模式/);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("accepts the english plugin namespace only on account 2", () => {
    const body = englishEnvelope({ source_namespace: "user-X--english", source_tool: "get_posts_by_ids" });
    expect(() => importEvidence(1, body)).toThrow(/不属于这个槽/);
    const saved = importEvidence(2, body);
    expect(saved.actualSourceNamespace).toBe("user-X--english");
    expect(saved.normalizedSource).toBe("user-plugin");
    expect(saved.sourceTool).toBe("get_posts_by_ids");
    expect(saved.activityWindowComplete).toBe(false);
  });
});

describe("account keyword config", () => {
  it("keeps account 2 edits off account 1 and does not pretend the legacy file is isolated", async () => {
    const first = await (await readFollowConfig(new Request("http://local/api/follow/config?accountId=1"))).json();
    const second = await (await readFollowConfig(new Request("http://local/api/follow/config?accountId=2"))).json();
    expect(first.keywords).toEqual(ACCOUNT1_KEYWORDS);
    expect(second.keywords).toEqual(ACCOUNT2_KEYWORDS);
    expect(first.shared).toBe(false);
    expect(first.savesDoNotStart).toBe(true);
    expect(first.running).toBe(false);
    const saved = await saveFollowConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 2, keywords: ["business", "dating"] }),
    }));
    expect((await saved.json()).keywords).toEqual(["business", "dating"]);
    expect((await (await readFollowConfig(new Request("http://local/api/follow/config?accountId=1"))).json()).keywords).toEqual(ACCOUNT1_KEYWORDS);
    expect((await (await readFollowConfig(new Request("http://local/api/follow/config?accountId=2"))).json()).keywords).toEqual(["business", "dating"]);
    const legacyOne = await (await legacyConfig(new Request("http://local/api/automation/config?accountId=1"))).json();
    const legacyTwo = await (await legacyConfig(new Request("http://local/api/automation/config?accountId=2"))).json();
    expect(legacyOne.accountScoped).toBe(false);
    expect(legacyOne.accountId).toBeNull();
    expect(legacyOne.config.keywordfollow.keywords).toEqual(legacyTwo.config.keywordfollow.keywords);
    expect(legacyOne.config.combinedFollowDailyCap).toBe(350);
    expect(legacyOne.config.keywordfollow.maxFollowers).toBe(1000);
    const statusOne = await (await legacyStatus(new Request("http://local/api/automation?accountId=1"))).json();
    const statusTwo = await (await legacyStatus(new Request("http://local/api/automation?accountId=2"))).json();
    expect(statusOne.accountScoped).toBe(false);
    expect(statusOne.config.keywordfollow.keywords).toEqual(statusTwo.config.keywordfollow.keywords);
    expect(statusOne.supervisor).toBe("off");
    expect(statusOne.daemons.unfollow.running).toBe(false);
    expect(statusOne.daemons.followback.running).toBe(false);
    expect(statusOne.daemons.keywordfollow.running).toBe(false);
  });

  it("checks the london windows from the app without reading X", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      throw new Error("network");
    };
    try {
      process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
      const first = await runDueAutomation(new Date("2026-11-08T00:30:00.000Z"));
      expect(first.map((item) => item.accountId)).toEqual([1]);
      expect(first[0].kind).toBe("follow");
      expect(first[0].slot).toBe("2026-11-08T00:30");
      const rest = await submitFollowBatch({
        accountId: 1,
        now: new Date("2026-11-08T00:45:00.000Z"),
        hooks: { inspect: async () => { throw new Error("no read"); }, follow: async () => { throw new Error("no write"); } },
      });
      expect(rest.reason).toBe("rest");
      expect(rest.slot).toBeNull();
      expect(rest.followed).toBe(0);
      expect(londonFollowSlot(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08T00:00");
      expect(londonFollowSlot(new Date("2026-11-08T00:14:00.000Z"))).toBe("2026-11-08T00:00");
      expect(londonFollowSlot(new Date("2026-11-08T00:15:00.000Z"))).toBeNull();
      expect(londonFollowSlot(new Date("2026-07-15T23:00:00.000Z"))).toBe("2026-07-16T00:00");
      expect(londonUnfollowSlot(new Date("2026-11-08T00:15:00.000Z"))).toBe("2026-11-08T00:15");
      expect(londonUnfollowSlot(new Date("2026-11-08T00:45:00.000Z"))).toBe("2026-11-08T00:45");
      expect(calls).toEqual([]);
    } finally {
      delete process.env.XUTIE_ACCOUNT1_FOLLOW;
      globalThis.fetch = original;
    }
  });
});
