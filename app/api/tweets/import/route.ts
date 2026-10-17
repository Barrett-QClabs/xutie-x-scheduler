import { asNumber, handle, readJson } from "@/lib/http";
import { importTweets } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return importTweets({
      source: typeof body.source === "string" ? body.source : "",
      format: body.format === "csv" ? "csv" : "text",
      startAt: typeof body.startAt === "string" ? body.startAt : "",
      intervalMinutes: asNumber(body.intervalMinutes),
      jitterMinutes: asNumber(body.jitterMinutes),
    });
  });
}
