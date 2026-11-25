import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chineseZoneCheck, politicalCheck } from "../automation/follow-common.mjs";
import { inactiveStatus, recentlyFollowedIds } from "../automation/following-activity.mjs";
import { getDb } from "@/lib/db";
import { getPublicState, importTweets } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import { XApiError, type XClient } from "@/lib/x-client";

describe("duplicate slot fill does not revive other statuses", () => {
  it("moves the next pending tweet onto the failed slot and leaves a cancelled row alone", async () => {
    const now = new Date();
    importTweets({
      accountId: 1,
      source: "重复这条\n补位这条",
      format: "text",
      startAt: new Date(now.getTime() - 60_000).toISOString(),
      intervalMinutes: 25,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
      random: () => 0,
    });
    const stamp = now.toISOString();
    getDb()
      .prepare(
        `INSERT INTO tweets (
          id, text, weighted_length, status, scheduled_at, posted_at, tweet_id,
          error_message, attempt_count, sort_order, created_at, updated_at
        ) VALUES ('cancelled-1', '已取消', 6, 'cancelled', ?, NULL, NULL, NULL, 0, 99, ?, ?)`,
      )
      .run(new Date(now.getTime() + 60_000).toISOString(), stamp, stamp);

    const client: XClient = {
      verify: async () => ({ id: "1", username: "demo", name: "Demo" }),
      postTweet: async () => {
        throw new XApiError("You are not allowed to create a Tweet with duplicate content.", "duplicate", 403);
      },
    };
    const failed = await tick({ now, client, random: () => 0 });
    expect(failed.action).toBe("failed");
    const state = getPublicState(now);
    expect(state.tweets.find((tweet) => tweet.text === "重复这条")?.status).toBe("failed");
    expect(new Date(state.tweets.find((tweet) => tweet.text === "补位这条")!.scheduledAt).getTime()).toBe(now.getTime());
    expect(state.tweets.find((tweet) => tweet.id === "cancelled-1")?.status).toBe("cancelled");
    expect(state.activity.other).toBe(1);
    expect(state.counts.pending).toBe(1);

    const posted = await tick({
      now: new Date(now.getTime() + 5_000),
      random: () => 0,
      client: {
        verify: async () => ({ id: "1", username: "demo", name: "Demo" }),
        postTweet: async (text) => {
          expect(text).toBe("补位这条");
          return { id: "filled-slot" };
        },
      },
    });
    expect(posted).toMatchObject({ action: "posted", tweetId: "filled-slot" });
    const done = getPublicState();
    expect(done.tweets.find((tweet) => tweet.id === "cancelled-1")?.status).toBe("cancelled");
    expect(done.tweets.find((tweet) => tweet.text === "补位这条")?.status).toBe("posted");
  });
});

describe("local follow guards stay offline", () => {
  it("rejects political wording and still accepts an ordinary Chinese name", () => {
    expect(politicalCheck({ name: "反共评论", bio: "", tweetText: "" }).ok).toBe(false);
    expect(chineseZoneCheck({ tweetLang: "zh", name: "小明", bio: "做设计", tweetText: "今天开工" }).ok).toBe(true);
    expect(chineseZoneCheck({ tweetLang: "zh", name: "小明", bio: "反共", tweetText: "今天开工" }).ok).toBe(false);
  });

  it("classifies inactive rows and recent follows without reading the automation data dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-activity-"));
    const now = Date.parse("2026-11-07T09:00:00.000Z");
    fs.writeFileSync(
      path.join(dir, "followback.jsonl"),
      `${JSON.stringify({ id: "recent", result: "ok", time: "2026-11-07T08:30:00.000Z" })}\n` +
        `${JSON.stringify({ id: "old", result: "ok", time: "2026-11-01T08:30:00.000Z" })}\n`,
    );
    expect([...recentlyFollowedIds(24, now, dir)]).toEqual(["recent"]);
    const fresh = inactiveStatus(
      { checked_at: "2026-11-07T08:00:00.000Z", last_any_at: "2026-11-06T08:00:00.000Z" },
      {},
      now,
    );
    expect(fresh.state).toBe("inactive");
    const active = inactiveStatus(
      { checked_at: "2026-11-07T08:30:00.000Z", last_any_at: "2026-11-07T08:00:00.000Z" },
      {},
      now,
    );
    expect(active.state).toBe("active");
  });

  it("rejects unknown writer flags and does not create a cache file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-writers-"));
    const env = { ...process.env, X_AUTOMATION_DIR: dir };
    const followers = spawnSync(process.execPath, ["automation/write-followers-cache.mjs", "--help"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    expect(followers.status).toBe(2);
    expect(fs.existsSync(path.join(dir, "followers-free-cache.json"))).toBe(false);
    const targets = spawnSync(process.execPath, ["automation/write-followback-targets.mjs", "--help"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    expect(targets.status).toBe(2);
    expect(fs.existsSync(path.join(dir, "followback-targets.json"))).toBe(false);
  });
});
