import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { removeTweet, updateTweetText } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return handle(async () => {
    const body = await readJson(request);
    return updateTweetText(accountIdFrom(request, body), id, body.text);
  });
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return handle(() => removeTweet(accountIdFrom(request), id));
}
