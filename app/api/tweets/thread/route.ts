import { handle, readJson } from "@/lib/http";
import { queueThread } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return queueThread({ posts: body.posts, startAt: typeof body.startAt === "string" ? body.startAt : "" });
  });
}
