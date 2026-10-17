import { handle, readJson } from "@/lib/http";
import { clearCredentials, saveCredentials } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return saveCredentials({
      apiKey: text(body.apiKey),
      apiSecret: text(body.apiSecret),
      accessToken: text(body.accessToken),
      accessTokenSecret: text(body.accessTokenSecret),
    });
  });
}

export function DELETE() {
  return handle(() => clearCredentials());
}
