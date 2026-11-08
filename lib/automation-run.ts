import type { AccountId } from "@/lib/account";
import { followEnabled, unfollowEnabled } from "@/lib/automation-account";
import { submitFollowBatch } from "@/lib/follow-queue";
import { submitUnfollowBatch } from "@/lib/unfollow-queue";

const globalState = globalThis as unknown as { __xutiAutomationRunner?: boolean };

/** One check of the London follow and unfollow windows. Does not read X. */
export async function runDueAutomation(now = new Date()) {
  const results: Array<{ accountId: AccountId; kind: "follow" | "unfollow"; executed: boolean; reason: string | null; slot: string | null }> = [];
  for (const accountId of [1, 2] as const) {
    if (followEnabled(accountId)) {
      const follow = await submitFollowBatch({ accountId, now });
      results.push({ accountId, kind: "follow", executed: follow.executed, reason: follow.reason, slot: follow.slot });
    }
    if (unfollowEnabled(accountId)) {
      const unfollow = await submitUnfollowBatch({ accountId, now });
      results.push({ accountId, kind: "unfollow", executed: unfollow.executed, reason: unfollow.reason, slot: unfollow.slot });
    }
  }
  return results;
}

/** The process itself checks every 20 seconds. A half-hour cron misses follow windows that open at :15 and :45 offsets. */
export function startAutomationRunner(): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (globalState.__xutiAutomationRunner) return;
  globalState.__xutiAutomationRunner = true;
  const timer = setInterval(() => {
    void runDueAutomation().catch((error) => {
      console.error("[序帖] 关注调度失败", error instanceof Error ? error.message : error);
    });
  }, 20_000);
  timer.unref?.();
}
