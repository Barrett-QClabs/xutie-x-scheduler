import type { AccountId } from "@/lib/account";
import { ACCOUNT_USER_ID } from "@/lib/automation-account";
import { getCredentialsRow } from "@/lib/db";
import { apiMode } from "@/lib/deployment";
import { readCredentials } from "@/lib/service";
import type { FreshProfile, UnfollowHooks } from "@/lib/unfollow-queue";
import { xDelete, xGet } from "@/lib/x-client";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Confirmed signals only. A missing field stays null so the caller will not guess. */
export function profileFromLookup(user: Record<string, unknown> | null, tweets: Record<string, unknown> | null): FreshProfile {
  if (!user) {
    return { following: null, blue: null, followsBack: null, lastPostAt: null, lastPostKnown: false };
  }
  const connection = Array.isArray(user.connection_status) ? user.connection_status.filter((item) => typeof item === "string") : null;
  const following = connection ? connection.includes("following") : null;
  const followsBack = connection ? connection.includes("followed_by") : null;
  const verifiedKnown = typeof user.verified === "boolean" || typeof user.verified_type === "string";
  let blue: boolean | null = null;
  if (verifiedKnown) {
    const kind = typeof user.verified_type === "string" ? user.verified_type.toLowerCase() : "";
    blue = user.verified === true || (kind !== "" && kind !== "none");
  }
  let lastPostKnown = false;
  let lastPostAt: string | null = null;
  if (tweets && Array.isArray(tweets.data)) {
    lastPostKnown = true;
    for (const item of tweets.data) {
      const record = asRecord(item);
      const created = record && typeof record.created_at === "string" ? record.created_at : null;
      if (created && (!lastPostAt || created > lastPostAt)) lastPostAt = created;
    }
  }
  return { following, blue, followsBack, lastPostAt, lastPostKnown };
}

const unknownProfile = (): FreshProfile => ({
  following: null,
  blue: null,
  followsBack: null,
  lastPostAt: null,
  lastPostKnown: false,
});

/** Live hooks only. Mock mode returns nothing, so the batch cannot call X. */
export function liveUnfollowHooks(accountId: AccountId): UnfollowHooks | undefined {
  if (apiMode() !== "live") return undefined;
  const sourceUserId = getCredentialsRow(accountId)?.user_id;
  if (sourceUserId !== ACCOUNT_USER_ID[accountId]) return undefined;
  return {
    inspect: (targetUserId) => inspectTarget(accountId, sourceUserId, targetUserId),
    unfollow: (targetUserId) => unfollowTarget(accountId, sourceUserId, targetUserId),
  };
}

export async function inspectTarget(accountId: AccountId, sourceUserId: string, targetUserId: string): Promise<FreshProfile> {
  if (apiMode() !== "live") return unknownProfile();
  const credentials = readCredentials(accountId);
  if (!credentials) return unknownProfile();
  try {
    const users = await xGet(credentials, "/2/users", {
      ids: targetUserId,
      "user.fields": "connection_status,verified,verified_type",
    });
    const list = Array.isArray(users.data) ? users.data : [];
    const user = list.map(asRecord).find((item) => item?.id === targetUserId) ?? null;
    let tweets: Record<string, unknown> | null = null;
    try {
      tweets = await xGet(credentials, `/2/users/${encodeURIComponent(targetUserId)}/tweets`, {
        max_results: "5",
        "tweet.fields": "created_at",
      });
    } catch {
      tweets = null;
    }
    return profileFromLookup(user, tweets);
  } catch {
    return unknownProfile();
  }
}

export async function unfollowTarget(accountId: AccountId, sourceUserId: string, targetUserId: string): Promise<void> {
  if (apiMode() !== "live") throw new Error("mock mode does not unfollow");
  const credentials = readCredentials(accountId);
  if (!credentials) throw new Error("missing account 1 credentials");
  await xDelete(
    credentials,
    `/2/users/${encodeURIComponent(sourceUserId)}/following/${encodeURIComponent(targetUserId)}`,
  );
}
