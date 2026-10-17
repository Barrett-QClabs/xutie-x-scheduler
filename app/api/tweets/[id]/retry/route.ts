import { handle } from "@/lib/http";
import { retryTweet } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(() => retryTweet(id));
}
