import { accountIdFrom } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { listUnfollowCandidates } from "@/lib/unfollow-queue";

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
    if (page.before !== null && !/^\d+$/.test(page.before)) {
      throw new AppError("invalid_cursor", "取关候选 before 必须是数字 id。");
    }
    return listUnfollowCandidates(accountIdFrom(request), page);
  });
}
