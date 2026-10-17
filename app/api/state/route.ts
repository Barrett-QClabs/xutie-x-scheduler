import { getPublicState } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getPublicState());
}
