import { startDaemon } from "@/lib/automation";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return { ok: true, message: await startDaemon(String(body.daemon ?? "")) };
  });
}
