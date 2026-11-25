import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { resumeQueue } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return resumeQueue(accountIdFrom(request, body));
  });
}
