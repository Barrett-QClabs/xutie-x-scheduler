import { asNumber, handle, readJson } from "@/lib/http";
import { updateScheduleSettings } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return updateScheduleSettings({
      intervalMinutes: asNumber(body.intervalMinutes),
      jitterMinutes: asNumber(body.jitterMinutes),
      reschedule: body.reschedule === true,
      startAt: typeof body.startAt === "string" ? body.startAt : undefined,
    });
  });
}
