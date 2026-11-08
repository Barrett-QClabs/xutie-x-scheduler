import type { AccountId } from "@/lib/account";
import { ACCOUNT_USER_ID } from "@/lib/automation-account";
import { getCredentialsRow } from "@/lib/db";
import { apiMode } from "@/lib/deployment";
import { readCredentials } from "@/lib/service";
import type { FollowHooks, FollowProfile } from "@/lib/follow-queue";
import { xGet, xPost } from "@/lib/x-client";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

const unknownProfile = (): FollowProfile => ({
  blue: null,
  following: null,
  followsBack: null,
  followers: null,
  name: null,
  bio: null,
  username: null,
  tweetLang: null,
  tweetText: null,
  lastPostAt: null,
  lastPostKnown: false,
});

export function profileFromFollowLookup(user: Record<string, unknown> | null, tweets: Record<string, unknown> | null): FollowProfile {
  if (!user) return unknownProfile();
  const connection = Array.isArray(user.connection_status) ? user.connection_status.filter((item) => typeof item === "string") : null;
  const verifiedKnown = typeof user.verified === "boolean" || typeof user.verified_type === "string";
  let blue: boolean | null = null;
  if (verifiedKnown) {
    const kind = typeof user.verified_type === "string" ? user.verified_type.toLowerCase() : "";
    blue = user.verified === true || (kind !== "" && kind !== "none");
  }
  const metrics = asRecord(user.public_metrics);
  const followers = metrics && typeof metrics.followers_count === "number" ? metrics.followers_count : null;
  let lastPostKnown = false;
  let lastPostAt: string | null = null;
  let tweetLang: string | null = null;
  let tweetText: string | null = null;
  if (tweets && Array.isArray(tweets.data)) {
    lastPostKnown = true;
    for (const item of tweets.data) {
      const record = asRecord(item);
      const created = record && typeof record.created_at === "string" ? record.created_at : null;
      if (created && (!lastPostAt || created > lastPostAt)) {
        lastPostAt = created;
        tweetLang = record && typeof record.lang === "string" ? record.lang : null;
        tweetText = record && typeof record.text === "string" ? record.text : null;
      }
    }
  }
  return {
    blue,
    following: connection ? connection.includes("following") : null,
    followsBack: connection ? connection.includes("followed_by") : null,
    followers,
    name: typeof user.name === "string" ? user.name : null,
    bio: typeof user.description === "string" ? user.description : null,
    username: typeof user.username === "string" ? user.username : null,
    tweetLang,
    tweetText,
    lastPostAt,
    lastPostKnown,
  };
}

export function liveFollowHooks(accountId: AccountId): FollowHooks | undefined {
  if (apiMode() !== "live") return undefined;
  const sourceUserId = getCredentialsRow(accountId)?.user_id;
  if (sourceUserId !== ACCOUNT_USER_ID[accountId]) return undefined;
  return {
    inspect: (targetUserId) => inspectFollowTarget(accountId, targetUserId),
    follow: (targetUserId) => followTarget(accountId, sourceUserId, targetUserId),
  };
}

export async function inspectFollowTarget(accountId: AccountId, targetUserId: string): Promise<FollowProfile> {
  if (apiMode() !== "live") return unknownProfile();
  const credentials = readCredentials(accountId);
  if (!credentials) return unknownProfile();
  try {
    const users = await xGet(credentials, "/2/users", {
      ids: targetUserId,
      "user.fields": "connection_status,verified,verified_type,public_metrics,description,name,username",
    });
    const list = Array.isArray(users.data) ? users.data : [];
    const user = list.map(asRecord).find((item) => item?.id === targetUserId) ?? null;
    let tweets: Record<string, unknown> | null = null;
    try {
      tweets = await xGet(credentials, `/2/users/${encodeURIComponent(targetUserId)}/tweets`, {
        max_results: "5",
        "tweet.fields": "created_at,lang,text",
      });
    } catch {
      tweets = null;
    }
    return profileFromFollowLookup(user, tweets);
  } catch {
    return unknownProfile();
  }
}

export async function followTarget(accountId: AccountId, sourceUserId: string, targetUserId: string): Promise<void> {
  if (apiMode() !== "live") throw new Error("mock mode does not follow");
  const credentials = readCredentials(accountId);
  if (!credentials) throw new Error("missing account credentials");
  await xPost(credentials, `/2/users/${encodeURIComponent(sourceUserId)}/following`, { target_user_id: targetUserId });
}
