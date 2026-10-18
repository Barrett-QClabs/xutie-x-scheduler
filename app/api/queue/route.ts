import { asNumber, handle, optionalNumber, readJson } from "@/lib/http";
import { updateScheduleSettings } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return updateScheduleSettings({
      intervalMinutes: asNumber(body.intervalMinutes),
      // Legacy `jitterMinutes` is ignored; omitted values fall back to the saved (or default) range.
      randomMinSeconds: optionalNumber(body.randomMinSeconds),
      randomMaxSeconds: optionalNumber(body.randomMaxSeconds),
      reschedule: body.reschedule === true,
      startAt: typeof body.startAt === "string" ? body.startAt : undefined,
    });
  });
}
