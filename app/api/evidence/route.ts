import { accountIdFrom } from "@/lib/account";
import { evidenceCoverage, importEvidence } from "@/lib/evidence";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => evidenceCoverage(accountIdFrom(request)));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const slot = accountIdFrom(request, body);
    const envelope = body.evidence;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new AppError("invalid_evidence", "evidence 必须是对象。");
    }
    return importEvidence(slot, envelope as Record<string, unknown>);
  });
}
