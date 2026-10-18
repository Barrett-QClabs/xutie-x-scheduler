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

export interface XClient {
  verify(): Promise<XUser>;
  postTweet(text: string): Promise<{ id: string }>;
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
    postTweet: (text) => postTweet(credentials, text),
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

async function latestTweet(credentials: Credentials, userId: string): Promise<XTimelineTweet | null> {
  const payload = await xRequest(credentials, "GET", `/2/users/${encodeURIComponent(userId)}/tweets`, {
    max_results: "5",
    "tweet.fields": "created_at",
    exclude: "retweets,replies",
  });
  if (!Array.isArray(payload.data)) return null;
  let best: { id: string; createdAt: string; time: number } | null = null;
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.created_at !== "string") continue;
    const time = new Date(record.created_at).getTime();
    if (Number.isNaN(time)) continue;
    if (!best || time > best.time) best = { id: record.id, createdAt: record.created_at, time };
  }
  return best ? { id: best.id, createdAt: best.createdAt } : null;
}

async function postTweet(credentials: Credentials, text: string): Promise<{ id: string }> {
  const payload = await xRequest(credentials, "POST", "/2/tweets", undefined, { text });
  const data = payload.data;
  if (!data || typeof data !== "object" || typeof (data as { id?: unknown }).id !== "string") {
    throw new XApiError("X 没有返回帖子 id。", "rejected", 200);
  }
  return { id: (data as { id: string }).id };
}

async function xRequest(
  credentials: Credentials,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
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
    });
  } catch {
    throw new XApiError("连不上 X 的服务器。", "transient", 0);
  }
  if (!response.ok) throw await toXApiError(response);
  return (await response.json()) as { data?: unknown };
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

export function classifyStatus(status: number, message: string, body: unknown): XErrorKind {
  if (status === 429) return "rate_limit";
  const blob = `${message} ${JSON.stringify(body ?? {})}`.toLowerCase();
  if (blob.includes("duplicate")) return "duplicate";
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
