import { handle, readJson } from "@/lib/http";
import { testCredentials } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return testCredentials({
      apiKey: text(body.apiKey),
      apiSecret: text(body.apiSecret),
      accessToken: text(body.accessToken),
      accessTokenSecret: text(body.accessTokenSecret),
    });
  });
}
