import { AppError } from "@/lib/errors";

/** Fixed slots. Labels stay 账号1 / 账号2; a verified @handle is stored only after that account's own test. */
export type AccountId = 1 | 2;

export const ACCOUNT_IDS: readonly AccountId[] = [1, 2];

export const ACCOUNT_LABEL: Record<AccountId, "账号1" | "账号2"> = {
  1: "账号1",
  2: "账号2",
};

export function isAccountId(value: unknown): value is AccountId {
  return value === 1 || value === 2 || value === "1" || value === "2";
}

/** Rejects a missing or unknown account. Callers must not substitute the other account. */
export function parseAccountId(value: unknown): AccountId {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  throw new AppError("account_required", "请明确选择账号1或账号2。", 400);
}

export function accountIdFrom(request: Request, body?: Record<string, unknown> | null): AccountId {
  const query = new URL(request.url).searchParams.get("accountId");
  return parseAccountId(body && "accountId" in body ? body.accountId : query);
}
