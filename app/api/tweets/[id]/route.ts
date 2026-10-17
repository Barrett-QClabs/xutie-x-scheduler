import { handle, readJson } from "@/lib/http";
import { removeTweet, updateTweetText } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return handle(async () => {
    const body = await readJson(request);
    return updateTweetText(id, body.text);
  });
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  return handle(() => removeTweet(id));
}
