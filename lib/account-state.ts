import type { AccountId } from "@/lib/account";

/**
 * A state response belongs on screen only when it is the account still selected
 * and the account the request asked for. A late response for the other slot must be dropped.
 */
export function shouldApplyAccountState(input: {
  requestedId: AccountId;
  selectedId: AccountId;
  responseId: AccountId;
}): boolean {
  return input.requestedId === input.selectedId && input.responseId === input.requestedId;
}
