import { parseAccountId } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { deleteOwnPosts, intervalFromBody, resolvePostDeleteIntervalMs, tweetIdsFromBody } from "@/lib/post-delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A full batch sleeps 5–10s between writes. Self-hosted Next ignores this; Node's receive timeout does not cover the response. */
export const maxDuration = 3600;

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_json", "请求格式不正确。", 400);
  }
}

export async function POST(request: Request) {
  return handle(async () => {
    const accountId = parseAccountId(new URL(request.url).searchParams.get("accountId"));
    const body = await readBody(request);
    const intervalMs = resolvePostDeleteIntervalMs(intervalFromBody(body));
    return deleteOwnPosts({
      accountId,
      tweetIds: tweetIdsFromBody(body),
      intervalMs,
      signal: request.signal,
    });
  });
}
