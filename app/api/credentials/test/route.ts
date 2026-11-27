import { accountIdFrom } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { testCredentials } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Explicit, operator-triggered verification. In live mode this is the only place that may spend a
 * GET /2/users/me. `reverify: true` re-reads even when this slot already stores an identity.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    if (body.reverify !== undefined && typeof body.reverify !== "boolean") {
      throw new AppError("invalid_json", "reverify 必须是布尔值。");
    }
    return testCredentials(
      accountIdFrom(request, body),
      {
        apiKey: text(body.apiKey),
        apiSecret: text(body.apiSecret),
        accessToken: text(body.accessToken),
        accessTokenSecret: text(body.accessTokenSecret),
      },
      { reverify: body.reverify === true },
    );
  });
}
