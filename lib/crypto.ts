import crypto from "node:crypto";
import { AppError } from "@/lib/errors";

function passphrase(): string {
  const value = process.env.CREDENTIALS_ENCRYPTION_KEY?.trim() ?? "";
  if (value.length < 16) {
    throw new AppError(
      "encryption_key_missing",
      "服务器未配置 CREDENTIALS_ENCRYPTION_KEY（至少 16 位随机字符串）。",
      500,
    );
  }
  return value;
}

export function encryptString(plain: string, secret = passphrase()): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
}

export function decryptString(payload: string, secret = passphrase()): string {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, "base64");
    if (buffer.length < 16 + 12 + 16 + 1) throw new Error("short");
    const salt = buffer.subarray(0, 16);
    const iv = buffer.subarray(16, 28);
    const tag = buffer.subarray(28, 44);
    const encrypted = buffer.subarray(44);
    const key = crypto.scryptSync(secret, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "decrypt_failed",
      "无法解密已保存的凭据。加密密钥可能已变更，请重新填写四项凭据。",
      500,
    );
  }
}
