import type { Locale, MessageKey } from "@/lib/messages";

const CODE_KEYS: Record<string, MessageKey> = {
  encryption_key_missing: "errKey",
  decrypt_failed: "errDecrypt",
  credentials_incomplete: "errIncomplete",
  credentials_missing: "errMissing",
  not_found: "errNotFound",
  invalid_text: "errInvalidText",
  too_long: "errTooLong",
  invalid_interval: "errInterval",
  invalid_jitter: "errJitter",
  invalid_start: "errStart",
  start_too_late: "errStartLate",
  start_too_early: "errStartEarly",
  invalid_status: "errStatus",
  too_many: "errTooMany",
  invalid_json: "errJson",
  internal: "errInternal",
  x_network: "errNetwork",
};

export function explainError(
  error: unknown,
  locale: Locale,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "x_auth" || code === "x_error") {
    const detail = message.replace(/^凭据被 X 拒绝。|^X 接口返回错误。/, "");
    const prefix = t(code === "x_auth" ? "errXAuth" : "errXError");
    return locale === "zh" ? message || prefix : `${prefix} ${detail}`.trim();
  }
  const key = CODE_KEYS[code];
  if (key) return t(key);
  if (message) return message;
  return t("requestFailed");
}
