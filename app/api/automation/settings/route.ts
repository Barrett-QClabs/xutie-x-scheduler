import { accountIdFrom } from "@/lib/account";
import { automationSettingsView, resetAutomationSettings, saveAutomationSettings } from "@/lib/automation-settings";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-account settings. Unlike /api/automation/config, these are scoped to one account and drive execution. */
export function GET(request: Request) {
  return handle(() => automationSettingsView(accountIdFrom(request)));
}

/**
 * Partial update: `{ accountId, settings: { follow: { batchSize: 8 }, quotaTimezone: "Europe/London" } }`.
 * Unknown fields and out-of-range values fail with `invalid_settings`; nothing is written then.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    for (const key of Object.keys(body)) {
      if (key !== "accountId" && key !== "settings") {
        throw new AppError("invalid_settings", `未知字段 ${key}。请把要改的设置放在 settings 里。`);
      }
    }
    if (body.settings === undefined) throw new AppError("invalid_settings", "缺少 settings。");
    return saveAutomationSettings(accountId, body.settings);
  });
}

/** Back to this account's defaults. The other account is not touched. */
export function DELETE(request: Request) {
  return handle(() => resetAutomationSettings(accountIdFrom(request)));
}
