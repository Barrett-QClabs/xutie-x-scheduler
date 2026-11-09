import { accountIdFrom } from "@/lib/account";
import { listReserveAudit } from "@/lib/follow-queue";
import { AppError } from "@/lib/errors";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pageQuery(request: Request): { limit?: number; before: string | null } {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const before = url.searchParams.get("before");
  return {
    limit: rawLimit === null ? undefined : Number(rawLimit),
    before: before === null || before === "" ? null : before,
  };
}

export function GET(request: Request) {
  return handle(() => {
    const page = pageQuery(request);
    if (page.before !== null && Number.isNaN(Date.parse(page.before))) {
      throw new AppError("invalid_cursor", "储备审计 before 必须是可解析的时间。");
    }
    return listReserveAudit(accountIdFrom(request), page);
  });
}
