import crypto from "node:crypto";
import type { Credentials } from "@/lib/types";

export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

export function buildAuthorizationHeader(options: {
  method: string;
  url: string;
  credentials: Credentials;
  extraParams?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}): { header: string; signature: string } {
  const nonce = options.nonce ?? crypto.randomBytes(16).toString("hex");
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const oauth: Record<string, string> = {
    oauth_consumer_key: options.credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: options.credentials.accessToken,
    oauth_version: "1.0",
  };
  const signed = { ...oauth, ...(options.extraParams ?? {}) };
  const parameterString = Object.keys(signed)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(signed[key])}`)
    .join("&");
  const base = [
    options.method.toUpperCase(),
    percentEncode(options.url),
    percentEncode(parameterString),
  ].join("&");
  const signingKey = `${percentEncode(options.credentials.apiSecret)}&${percentEncode(options.credentials.accessTokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  const headerParams: Record<string, string> = { ...oauth, oauth_signature: signature };
  const header = `OAuth ${Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(", ")}`;
  return { header, signature };
}
