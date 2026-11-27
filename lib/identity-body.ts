/**
 * Client-safe request bodies for the slot identity endpoints:
 * - `POST /api/credentials/test`: explicit verification with this slot's saved keys. An ordinary
 *   retest sends no `reverify`, so a slot that already stores an identity is not re-read from X.
 *   `reverify: true` is sent only when the operator asks for a fresh `GET /2/users/me`.
 * - `PUT /api/credentials/identity`: manual fallback when the live read is unavailable.
 * Only the visible slot's `accountId` goes into a body. Rules mirror `lib/account-identity.ts`.
 */
import type { AccountId } from "@/lib/account";
import type { IdentityState } from "@/lib/account-identity";

export type CredentialsTestBody = { accountId: AccountId; reverify?: true };

export function credentialsTestBody(accountId: AccountId, options: { reverify?: boolean } = {}): CredentialsTestBody {
  return options.reverify === true ? { accountId, reverify: true } : { accountId };
}

export type ManualIdentityInput = { userId: string; username: string; displayName: string };

export type ManualIdentityBody = { accountId: AccountId; userId: string; username: string; displayName?: string };

export type IdentityIssue = { field: keyof ManualIdentityInput; zh: string; en: string };

/** Same ceiling the server applies to `displayName`. */
export const DISPLAY_NAME_MAX = 50;

export const emptyManualIdentity = (): ManualIdentityInput => ({ userId: "", username: "", displayName: "" });

/**
 * Validates the manual identity form and builds the PUT body for `accountId` only. The user id is
 * sent as a string, a leading `@` is dropped from the username, and a blank display name is left
 * out (the server then uses the username).
 */
export function manualIdentityRequest(
  accountId: AccountId,
  input: ManualIdentityInput,
): { body: ManualIdentityBody | null; issues: IdentityIssue[] } {
  const issues: IdentityIssue[] = [];
  const userId = input.userId.trim();
  const username = input.username.trim().replace(/^@/, "");
  const displayName = input.displayName.trim();
  if (!/^\d{1,32}$/.test(userId)) {
    issues.push({ field: "userId", zh: "用户 id 必须是 X 的数字 id（1 到 32 位数字）。", en: "User id must be the numeric X id (1 to 32 digits)." });
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    issues.push({ field: "username", zh: "用户名必须是 1 到 15 位字母、数字或下划线，可以带 @。", en: "Username must be 1 to 15 letters, digits, or underscores, with an optional @." });
  }
  if (displayName.length > DISPLAY_NAME_MAX) {
    issues.push({ field: "displayName", zh: `显示名不能超过 ${DISPLAY_NAME_MAX} 个字符。`, en: `Display name cannot be longer than ${DISPLAY_NAME_MAX} characters.` });
  }
  if (issues.length > 0) return { body: null, issues };
  const body: ManualIdentityBody = { accountId, userId, username };
  if (displayName) body.displayName = displayName;
  return { body, issues };
}

/** Follows and unfollows may run only as a confirmed identity. */
export function identityExecutionAllowed(state: IdentityState): boolean {
  return state === "confirmed";
}
