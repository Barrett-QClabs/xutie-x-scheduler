import { getConfig, updateConfig } from "@/lib/automation";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handle(() => ({ ok: true, config: getConfig() }));
}

export async function PATCH(request: Request) {
  return handle(async () => ({ ok: true, config: updateConfig(await readJson(request)) }));
}
