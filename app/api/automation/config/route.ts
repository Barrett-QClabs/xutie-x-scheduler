import { getConfig, updateConfig } from "@/lib/automation";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function shared(config: ReturnType<typeof getConfig>, requestedAccountId: string | null) {
  return {
    ok: true as const,
    scope: "shared" as const,
    accountScoped: false,
    accountId: null,
    requestedAccountId,
    appliedToAccount: false,
    note: "这是旧的全局 automation.config.json，不随 accountId 分开。分账号关键词使用 GET/PUT /api/follow/config。",
    config,
  };
}

export function GET(request: Request) {
  return handle(() => shared(getConfig(), new URL(request.url).searchParams.get("accountId")));
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    if ("accountId" in body) {
      throw new AppError("shared_config", "旧配置是全局的，不能按账号保存。请用 PUT /api/follow/config。", 400);
    }
    return shared(updateConfig(body), null);
  });
}
