import { accountIdFrom } from "@/lib/account";
import { describeMockScenario, listMockScenarios } from "@/lib/diagnostics";
import { AppError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { getPublicState } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local diagnosis only. This handler does not call X, does not post, and does not read stored credentials.
 * `?scenario=` looks up a built-in mock case. It does not apply that case to the queue.
 */
export function GET(request: Request) {
  return handle(() => {
    const scenarioId = new URL(request.url).searchParams.get("scenario");
    const state = getPublicState(new Date(), accountIdFrom(request));
    const payload: Record<string, unknown> = {
      ok: true,
      offline: true,
      callsX: false,
      activity: state.activity,
      deployment: state.deployment,
      accountId: state.accountId,
      accountLabel: state.accountLabel,
      slots: state.slots,
      mockScenarios: listMockScenarios(),
    };
    if (scenarioId) {
      const scenario = describeMockScenario(scenarioId);
      if (!scenario) throw new AppError("not_found", "没有这个模拟场景。", 404);
      payload.scenario = scenario;
    }
    return payload;
  });
}
