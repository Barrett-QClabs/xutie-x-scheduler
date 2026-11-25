import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { retryTweet } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(async () => {
    const body = await readJson(request);
    return retryTweet(accountIdFrom(request, body), id);
  });
}
