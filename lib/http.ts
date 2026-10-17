import { AppError } from "@/lib/errors";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("invalid_json", "请求格式不正确。");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_json", "请求格式不正确。");
  }
}

export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export async function handle(fn: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[序帖]", error instanceof Error ? error.message : error);
    return Response.json({ ok: false, code: "internal", message: "服务器内部错误。" }, { status: 500 });
  }
}
