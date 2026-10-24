import { buildAuthorizationHeader, percentEncode } from "@/lib/oauth";
import type { Credentials, XUser } from "@/lib/types";

export type XErrorKind = "rate_limit" | "duplicate" | "auth" | "transient" | "rejected";

export class XApiError extends Error {
  constructor(
    message: string,
    readonly kind: XErrorKind,
    readonly status: number,
    readonly resetAt?: Date,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export type XTimelineTweet = {
  id: string;
  createdAt: string;
};

export type PostOptions = { mediaIds?: string[]; replyTo?: string };

export interface XClient {
  verify(): Promise<XUser>;
  postTweet(text: string, options?: PostOptions): Promise<{ id: string }>;
  uploadMedia?(filePath: string): Promise<string>;
  latestTweet?(userId: string): Promise<XTimelineTweet | null>;
}

const API_BASE = "https://api.x.com";

export function isMockMode(): boolean {
  return process.env.X_API_MODE === "mock";
}

export function createXClient(credentials: Credentials): XClient {
  return isMockMode() ? createMockXClient(credentials) : createLiveXClient(credentials);
}

export function createLiveXClient(credentials: Credentials): XClient {
  return {
    verify: () => verifyCredentials(credentials),
    postTweet: (text, options) => postTweet(credentials, text, options),
    uploadMedia: (filePath) => uploadMedia(credentials, filePath),
    latestTweet: (userId) => latestTweet(credentials, userId),
  };
}

let mockSequence = 0;
let mockLatest: XTimelineTweet | null = null;

export function resetMockXClient(): void {
  mockSequence = 0;
  mockLatest = null;
}

export function setMockLatestTweet(tweet: XTimelineTweet | null): void {
  mockLatest = tweet;
}

export function createMockXClient(credentials: Credentials): XClient {
  return {
    async latestTweet() {
      return mockLatest;
    },
    async uploadMedia(filePath: string) {
      mockSequence += 1;
      return `mock_media_${mockSequence}_${filePath.length}`;
    },
    async verify() {
      if (credentials.apiKey === "invalid" || credentials.accessToken === "invalid") {
        throw new XApiError("Invalid or expired token", "auth", 401);
      }
      const slug = credentials.apiKey.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
      return {
        id: "100000001",
        username: slug ? `mock_${slug}` : "mock_user",
        name: "模拟账号",
      };
    },
    async postTweet(text: string) {
      if (text.includes("[[auth]]")) {
        throw new XApiError("Invalid or expired token", "auth", 401);
      }
      if (text.includes("[[duplicate]]")) {
        throw new XApiError(
          "You are not allowed to create a Tweet with duplicate content.",
          "duplicate",
          403,
        );
      }
      if (text.includes("[[rate-limit]]")) {
        throw new XApiError("Rate limit exceeded", "rate_limit", 429, new Date(Date.now() + 15 * 60_000));
      }
      if (text.includes("[[too-long]]")) {
        throw new XApiError(
          "X 拒绝了这条长文：可能需要 X Premium，或超过了长度上限。X rejected this long post (X Premium may be required, or it is too long). [403] You are not permitted to create a Tweet with this length.",
          "rejected",
          403,
        );
      }
      if (text.includes("[[fail]]")) {
        throw new XApiError("Internal error", "transient", 503);
      }
      mockSequence += 1;
      const id = `mock_${Date.now()}_${mockSequence}`;
      mockLatest = { id, createdAt: new Date().toISOString() };
      return { id };
    },
  };
}

async function verifyCredentials(credentials: Credentials): Promise<XUser> {
  const query = { "user.fields": "id,name,username" };
  const payload = await xRequest(credentials, "GET", "/2/users/me", query);
  const data = payload.data;
  if (!data || typeof data !== "object") {
    throw new XApiError("X 没有返回账号信息。", "rejected", 200);
  }
  const record = data as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.username !== "string") {
    throw new XApiError("X 没有返回账号信息。", "rejected", 200);
  }
  return {
    id: record.id,
    username: record.username,
    name: typeof record.name === "string" ? record.name : record.username,
  };
}

function isReply(record: Record<string, unknown>): boolean {
  const refs = record.referenced_tweets;
  if (!Array.isArray(refs)) return false;
  return refs.some(
    (ref) => !!ref && typeof ref === "object" && (ref as { type?: unknown }).type === "replied_to",
  );
}

async function latestTweet(credentials: Credentials, userId: string): Promise<XTimelineTweet | null> {
  const payload = await xRequest(credentials, "GET", `/2/users/${encodeURIComponent(userId)}/tweets`, {
    max_results: "5",
    "tweet.fields": "created_at,referenced_tweets",
    exclude: "retweets,replies",
  });
  if (!Array.isArray(payload.data)) return null;
  let best: { id: string; createdAt: string; time: number } | null = null;
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.created_at !== "string") continue;
    // X still returns replies to your own posts (thread replies) even with exclude=replies.
    if (isReply(record)) continue;
    const time = new Date(record.created_at).getTime();
    if (Number.isNaN(time)) continue;
    if (!best || time > best.time) best = { id: record.id, createdAt: record.created_at, time };
  }
  return best ? { id: best.id, createdAt: best.createdAt } : null;
}

async function postTweet(credentials: Credentials, text: string, options?: PostOptions): Promise<{ id: string }> {
  const body: Record<string, unknown> = { text };
  if (options?.mediaIds?.length) body.media = { media_ids: options.mediaIds };
  if (options?.replyTo) body.reply = { in_reply_to_tweet_id: options.replyTo };
  const payload = await xRequest(credentials, "POST", "/2/tweets", undefined, body);
  const data = payload.data;
  if (!data || typeof data !== "object" || typeof (data as { id?: unknown }).id !== "string") {
    throw new XApiError("X 没有返回帖子 id。", "rejected", 200);
  }
  return { id: (data as { id: string }).id };
}

const X_REQUEST_TIMEOUT_MS = 20_000;
const X_UPLOAD_TIMEOUT_MS = 60_000;

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/mp4",
};

const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const VIDEO_STATUS_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_V1_BASE = "https://upload.x.com/1.1/media/upload.json";

/** Upload image (one-shot) or video (chunked INIT/APPEND/FINALIZE + STATUS). Returns media id. */
async function uploadMedia(credentials: Credentials, filePath: string): Promise<string> {
  const path = await import("node:path");
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_TYPES[ext]) return uploadVideo(credentials, filePath, VIDEO_TYPES[ext]);
  if (IMAGE_TYPES[ext]) return uploadImage(credentials, filePath, IMAGE_TYPES[ext]);
  throw new XApiError(`不支持的媒体格式：${filePath}`, "rejected", 0);
}

async function uploadImage(credentials: Credentials, filePath: string, type: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    throw new XApiError(`找不到图片文件：${filePath}`, "rejected", 0);
  }
  const url = `${API_BASE}/2/media/upload`;
  const { header } = buildAuthorizationHeader({ method: "POST", url, credentials });
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(bytes)], { type }), path.basename(filePath));
  form.append("media_category", "tweet_image");
  form.append("media_type", type);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: header, Accept: "application/json", "User-Agent": "xuti/0.1" },
      body: form,
      signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器（上传图片）。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
  const payload = (await response.json()) as { data?: { id?: unknown; media_id_string?: unknown }; media_id_string?: unknown };
  const id = payload.data?.id ?? payload.data?.media_id_string ?? payload.media_id_string;
  if (typeof id !== "string" || !id) throw new XApiError("X 没有返回图片 id。", "rejected", 200);
  return id;
}

async function uploadVideo(credentials: Credentials, filePath: string, mediaType: string): Promise<string> {
  const fs = await import("node:fs/promises");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    throw new XApiError(`找不到视频文件：${filePath}`, "rejected", 0);
  }
  try {
    return await uploadVideoV2(credentials, bytes, mediaType);
  } catch (error) {
    // Auth failures are fatal; other v2 failures (404 endpoint, shape, etc.) try v1.1.
    if (error instanceof XApiError && error.kind === "auth") throw error;
    console.warn("[序帖] X API v2 视频分块上传失败，改用 v1.1。", error instanceof Error ? error.message : error);
    return uploadVideoV1(credentials, bytes, mediaType);
  }
}

async function uploadVideoV2(credentials: Credentials, bytes: Buffer, mediaType: string): Promise<string> {
  const initPayload = await xRequest(
    credentials,
    "POST",
    "/2/media/upload/initialize",
    undefined,
    {
      media_type: mediaType,
      total_bytes: bytes.length,
      media_category: "amplify_video",
    },
    X_UPLOAD_TIMEOUT_MS,
  );
  const mediaId = extractMediaId(initPayload);
  if (!mediaId) throw new XApiError("X 没有返回视频 id（initialize）。", "rejected", 200);

  for (let offset = 0, segment = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES, segment += 1) {
    const chunk = bytes.subarray(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
    await appendMediaV2(credentials, mediaId, segment, chunk);
  }

  const finalizePayload = await xRequest(
    credentials,
    "POST",
    `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
    undefined,
    undefined,
    X_UPLOAD_TIMEOUT_MS,
  );
  await waitForMediaProcessing(credentials, mediaId, readProcessingInfo(finalizePayload), "v2");
  return mediaId;
}

async function appendMediaV2(
  credentials: Credentials,
  mediaId: string,
  segmentIndex: number,
  chunk: Buffer,
): Promise<void> {
  const url = `${API_BASE}/2/media/upload/${encodeURIComponent(mediaId)}/append`;
  const { header } = buildAuthorizationHeader({ method: "POST", url, credentials });
  const form = new FormData();
  form.append("segment_index", String(segmentIndex));
  form.append("media", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), `chunk${segmentIndex}.bin`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: header, Accept: "application/json", "User-Agent": "xuti/0.1" },
      body: form,
      signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器（上传视频分块）。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
}

async function uploadVideoV1(credentials: Credentials, bytes: Buffer, mediaType: string): Promise<string> {
  const init = await xUploadV1(credentials, {
    command: "INIT",
    total_bytes: String(bytes.length),
    media_type: mediaType,
    media_category: "amplify_video",
  });
  const mediaId = extractMediaId(init);
  if (!mediaId) throw new XApiError("X 没有返回视频 id（v1 INIT）。", "rejected", 200);

  for (let offset = 0, segment = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES, segment += 1) {
    const chunk = bytes.subarray(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
    await appendMediaV1(credentials, mediaId, segment, chunk);
  }

  const finalize = await xUploadV1(credentials, { command: "FINALIZE", media_id: mediaId });
  await waitForMediaProcessing(credentials, mediaId, readProcessingInfo(finalize), "v1");
  return mediaId;
}

async function appendMediaV1(
  credentials: Credentials,
  mediaId: string,
  segmentIndex: number,
  chunk: Buffer,
): Promise<void> {
  const url = UPLOAD_V1_BASE;
  const { header } = buildAuthorizationHeader({
    method: "POST",
    url,
    credentials,
    extraParams: {
      command: "APPEND",
      media_id: mediaId,
      segment_index: String(segmentIndex),
    },
  });
  const form = new FormData();
  form.append("command", "APPEND");
  form.append("media_id", mediaId);
  form.append("segment_index", String(segmentIndex));
  form.append("media", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), `chunk${segmentIndex}.bin`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: header, Accept: "application/json", "User-Agent": "xuti/0.1" },
      body: form,
      signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器（v1 上传视频分块）。", "transient", 0);
  }
  // APPEND often returns 204 No Content
  if (!response.ok && response.status !== 204) throw await toXApiError(response);
}

async function xUploadV1(
  credentials: Credentials,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = UPLOAD_V1_BASE;
  const { header } = buildAuthorizationHeader({ method: "POST", url, credentials, extraParams: params });
  const body = new URLSearchParams(params);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: header,
        Accept: "application/json",
        "User-Agent": "xuti/0.1",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器（v1 视频上传）。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}

type ProcessingInfo = { state?: string; check_after_secs?: number; error?: { message?: string } };

function readProcessingInfo(payload: unknown): ProcessingInfo | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  const info = data.processing_info;
  if (!info || typeof info !== "object") return undefined;
  return info as ProcessingInfo;
}

function extractMediaId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const candidates = [data?.id, data?.media_id_string, record.id, record.media_id_string, record.media_id];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

async function waitForMediaProcessing(
  credentials: Credentials,
  mediaId: string,
  initial: ProcessingInfo | undefined,
  mode: "v2" | "v1",
): Promise<void> {
  let info = initial;
  if (!info) return;
  const deadline = Date.now() + VIDEO_STATUS_TIMEOUT_MS;
  while (true) {
    const state = (info.state ?? "").toLowerCase();
    if (state === "succeeded" || state === "success") return;
    if (state === "failed" || state === "error") {
      const detail = info.error?.message ? `：${info.error.message}` : "";
      throw new XApiError(`视频处理失败${detail}`, "rejected", 0);
    }
    if (Date.now() > deadline) throw new XApiError("视频处理超时。", "transient", 0);
    const waitSecs = Math.max(1, Number(info.check_after_secs) || 2);
    await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000));
    info =
      mode === "v2"
        ? readProcessingInfo(
            await xRequest(
              credentials,
              "GET",
              "/2/media/upload",
              { command: "STATUS", media_id: mediaId },
              undefined,
              X_UPLOAD_TIMEOUT_MS,
            ),
          )
        : readProcessingInfo(await xUploadV1GetStatus(credentials, mediaId));
    if (!info) return;
  }
}

async function xUploadV1GetStatus(credentials: Credentials, mediaId: string): Promise<Record<string, unknown>> {
  const url = UPLOAD_V1_BASE;
  const query = { command: "STATUS", media_id: mediaId };
  const { header } = buildAuthorizationHeader({ method: "GET", url, credentials, extraParams: query });
  const queryString = `?command=STATUS&media_id=${percentEncode(mediaId)}`;
  let response: Response;
  try {
    response = await fetch(`${url}${queryString}`, {
      method: "GET",
      headers: { Authorization: header, Accept: "application/json", "User-Agent": "xuti/0.1" },
      signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器（v1 STATUS）。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
  return (await response.json()) as Record<string, unknown>;
}

async function xRequest(
  credentials: Credentials,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
  timeoutMs: number = X_REQUEST_TIMEOUT_MS,
): Promise<{ data?: unknown }> {
  const url = `${API_BASE}${path}`;
  const { header } = buildAuthorizationHeader({
    method,
    url,
    credentials,
    extraParams: query,
  });
  const queryString = query
    ? `?${Object.entries(query)
        .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
        .join("&")}`
    : "";
  let response: Response;
  try {
    response = await fetch(`${url}${queryString}`, {
      method,
      headers: {
        Authorization: header,
        Accept: "application/json",
        "User-Agent": "xuti/0.1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Never let a stalled connection block the 5 s scheduler loop (ticks run one after another).
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new XApiError("连不上 X 的服务器。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as { data?: unknown };
}

export async function toXApiError(response: Response): Promise<XApiError> {
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { detail: raw.slice(0, 300) };
  }
  const message = extractMessage(body) || `X API 错误（${response.status}）`;
  const kind = classifyStatus(response.status, message, body);
  if (kind === "rejected" && (response.status === 400 || response.status === 403) && isLengthRejection(`${message} ${JSON.stringify(body ?? {})}`)) {
    return new XApiError(
      `X 拒绝了这条长文：可能需要 X Premium，或超过了长度上限。X rejected this long post (X Premium may be required, or it is too long). [${response.status}] ${message}`,
      kind,
      response.status,
    );
  }
  const resetAt = kind === "rate_limit" ? readReset(response) : undefined;
  return new XApiError(message, kind, response.status, resetAt);
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
  if (Array.isArray(record.errors) && record.errors[0] && typeof record.errors[0] === "object") {
    const first = record.errors[0] as Record<string, unknown>;
    if (typeof first.message === "string" && first.message.trim()) return first.message.trim();
  }
  if (typeof record.title === "string") return record.title;
  return "";
}

const LENGTH_PATTERN = /too long|length|premium|character/;

export function isLengthRejection(blob: string): boolean {
  return LENGTH_PATTERN.test(blob.toLowerCase());
}

export function classifyStatus(status: number, message: string, body: unknown): XErrorKind {
  if (status === 429) return "rate_limit";
  const blob = `${message} ${JSON.stringify(body ?? {})}`.toLowerCase();
  if (blob.includes("duplicate")) return "duplicate";
  // A long post refused for length / missing Premium fails on its own; never treat it as an auth problem.
  if ((status === 400 || status === 403) && isLengthRejection(blob)) return "rejected";
  if (status === 401) return "auth";
  if (
    status === 403 &&
    /authentic|oauth|token|credential|not authorized|unauthorized|permission/.test(blob)
  ) {
    return "auth";
  }
  if (status === 0 || status === 408 || status >= 500) return "transient";
  return "rejected";
}

function readReset(response: Response): Date | undefined {
  const reset = response.headers.get("x-rate-limit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const value = Number(reset);
    return new Date(value > 1e12 ? value : value * 1000);
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return new Date(Date.now() + Number(retryAfter) * 1000);
  }
  return undefined;
}
