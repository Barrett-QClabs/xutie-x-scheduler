import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { reorderTweet } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const direction = body.direction === "up" || body.direction === "down" ? body.direction : "up";
    return reorderTweet(accountIdFrom(request, body), typeof body.id === "string" ? body.id : "", direction);
  });
}
