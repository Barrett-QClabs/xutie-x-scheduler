import { describe, expect, it } from "vitest";
import { updateAccount } from "@/lib/db";
import { getPublicState, importTweets, saveCredentials, updateScheduleSettings } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import type { XClient } from "@/lib/x-client";

const user = { id: "42", username: "demo", name: "Demo" };

/** Simulate the real 5 s tick loop against a fake X account and record actual post times. */
describe("punctual posting (5 s tick simulation)", () => {
  it("posts at scheduledAt, shifts once after a manual post, and never posts closer than the interval", async () => {
    saveCredentials({ apiKey: "abc12345", apiSecret: "s3cret-value", accessToken: "tok-value", accessTokenSecret: "toksecret" });
    updateAccount({ username: user.username, displayName: user.name, userId: user.id });
    const start = new Date(Date.now() + 60_000);
    importTweets({ source: "一\n二\n三\n四\n五", format: "text", startAt: start.toISOString(), intervalMinutes: 16 });
    updateScheduleSettings({ intervalMinutes: 16, randomMinSeconds: 60, randomMaxSeconds: 120, reschedule: true, startAt: start.toISOString() });

    const timeline: { id: string; at: number }[] = [];
    let seq = 0;
    let rand = 0.37;
    const random = () => (rand = (rand * 9301 + 49297) % 233280 / 233280);
    let now = start.getTime() - 10_000;
    const client: XClient = {
      verify: async () => user,
      postTweet: async () => {
        const id = `p${++seq}`;
        timeline.push({ id, at: now });
        return { id };
      },
      latestTweet: async () => {
        const last = timeline.filter((t) => t.at <= now).at(-1);
        return last ? { id: last.id, createdAt: new Date(last.at).toISOString() } : null;
      },
    };

    const manualAt = start.getTime() + 25 * 60_000; // between post 2 and 3
    const lateness: number[] = [];
    const shiftedTargets = new Set<string>();
    for (let step = 0; step < 2000; step += 1) {
      now += 5_000;
      if (now >= manualAt && !timeline.some((t) => t.id === "manual")) timeline.push({ id: "manual", at: manualAt });
      const before = getPublicState().tweets.find((t) => t.status === "pending");
      const result = await tick({ now: new Date(now), client, random });
      if (result.action === "deferred") shiftedTargets.add(result.until);
      if (result.action === "posted" && before) lateness.push(now - new Date(before.scheduledAt).getTime());
      if (getPublicState().counts.pending === 0) break;
    }
    expect(getPublicState().counts.posted).toBe(5);
    for (const late of lateness) expect(late).toBeLessThanOrEqual(5_000);
    // The manual post moved the queue exactly once to a single stable target.
    expect(shiftedTargets.size).toBe(1);
    const [target] = [...shiftedTargets].map((s) => new Date(s).getTime());
    expect(target - manualAt).toBeGreaterThanOrEqual(17 * 60_000);
    expect(target - manualAt).toBeLessThanOrEqual(18 * 60_000);
    const sorted = [...timeline].sort((a, b) => a.at - b.at);
    // Every post the scheduler makes is at least one interval after the previous post (ours or manual).
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].id !== "manual") expect(sorted[i].at - sorted[i - 1].at).toBeGreaterThanOrEqual(16 * 60_000);
    }
  });
});
