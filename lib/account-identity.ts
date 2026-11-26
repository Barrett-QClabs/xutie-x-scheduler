import { ACCOUNT_LABEL, type AccountId } from "@/lib/account";
import { LEGACY_ACCOUNT_USER_ID } from "@/lib/automation-account";
import { getCredentialsRow, updateAccount } from "@/lib/db";
import { AppError } from "@/lib/errors";

/**
 * Slot identity. Each slot acts only as the X user stored on its own credentials row.
 * - `missing`: no credentials or no stored user id yet.
 * - `conflict`: the other slot stores the same user id. Both slots stop until one is changed.
 * - `reserved`: the id is the other slot's legacy production identity.
 * - `confirmed`: follows and unfollows may run as this id.
 */
export type IdentityState = "confirmed" | "missing" | "conflict" | "reserved";

export type AccountIdentityView = {
  accountId: AccountId;
  credentialsConfigured: boolean;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  source: string | null;
  verifiedAt: string | null;
  state: IdentityState;
  executionAllowed: boolean;
};

function otherSlot(accountId: AccountId): AccountId {
  return accountId === 1 ? 2 : 1;
}

/** Why `accountId` may not hold `userId`, or null when it may. */
export function identityBlocker(accountId: AccountId, userId: string): "conflict" | "reserved" | null {
  const other = otherSlot(accountId);
  if (LEGACY_ACCOUNT_USER_ID[other] === userId) return "reserved";
  if (getCredentialsRow(other)?.user_id === userId) return "conflict";
  return null;
}

export function accountIdentity(accountId: AccountId): AccountIdentityView {
  const row = getCredentialsRow(accountId);
  const userId = row?.user_id?.trim() || null;
  const state: IdentityState = userId ? (identityBlocker(accountId, userId) ?? "confirmed") : "missing";
  return {
    accountId,
    credentialsConfigured: Boolean(row),
    userId,
    username: row?.username ?? null,
    displayName: row?.display_name ?? null,
    source: userId ? (row?.identity_source ?? "legacy") : null,
    verifiedAt: row?.identity_verified_at ?? null,
    state,
    executionAllowed: state === "confirmed",
  };
}

/** The user id follows and unfollows run as, or null when this slot must not act. */
export function executionUserId(accountId: AccountId): string | null {
  const identity = accountIdentity(accountId);
  return identity.state === "confirmed" ? identity.userId : null;
}

/**
 * Source user id that evidence for this slot must name. A confirmed identity wins. A slot with no
 * stored identity keeps its legacy production id for evidence only. A blocked identity accepts none.
 */
export function evidenceSourceUserId(accountId: AccountId): string | null {
  const identity = accountIdentity(accountId);
  if (identity.state === "confirmed") return identity.userId;
  if (identity.state !== "missing") return null;
  const legacy = LEGACY_ACCOUNT_USER_ID[accountId];
  return identityBlocker(accountId, legacy) ? null : legacy;
}

export function assertIdentityAvailable(accountId: AccountId, userId: string): void {
  const blocker = identityBlocker(accountId, userId);
  const other = ACCOUNT_LABEL[otherSlot(accountId)];
  if (blocker === "reserved") {
    throw new AppError("identity_conflict", `这个 X 账号属于${other}，不能保存到${ACCOUNT_LABEL[accountId]}。`, 409);
  }
  if (blocker === "conflict") {
    throw new AppError("identity_conflict", `${other}已经保存了同一个 X 账号。两个槽不能共用一个身份。`, 409);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Operator-entered identity for this slot's own saved keys. Used when the explicit live identity
 * read is unavailable. A wrong id cannot act as anyone else: X rejects writes whose path user id
 * does not match the signing token, and the follow lane pauses on that auth error.
 */
export function saveManualIdentity(
  accountId: AccountId,
  input: { userId?: unknown; username?: unknown; displayName?: unknown },
  now = new Date(),
): AccountIdentityView {
  if (!getCredentialsRow(accountId)) {
    throw new AppError("credentials_missing", "这个槽还没有保存凭据。身份只能挂在本槽自己的凭据上。", 400);
  }
  const userId = text(input.userId);
  if (!/^\d{1,32}$/.test(userId)) {
    throw new AppError("invalid_identity", "userId 必须是 X 的数字用户 id，以字符串提交。");
  }
  const username = text(input.username).replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new AppError("invalid_identity", "username 必须是 1 到 15 位字母、数字或下划线（可带 @）。");
  }
  if (input.displayName !== undefined && input.displayName !== null && typeof input.displayName !== "string") {
    throw new AppError("invalid_identity", "displayName 必须是字符串。");
  }
  const displayName = text(input.displayName) || username;
  if (displayName.length > 50) {
    throw new AppError("invalid_identity", "displayName 不能超过 50 个字符。");
  }
  assertIdentityAvailable(accountId, userId);
  updateAccount(accountId, { username, displayName, userId }, "manual", now);
  return accountIdentity(accountId);
}
