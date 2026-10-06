// 通用工具：时间（UTC+8 语义）、口令、文件名清洗、SHA256、base64url

export const TZ_OFFSET_MS = 8 * 3600 * 1000; // UTC+8

/** 当前 Unix 毫秒（UTC 绝对时间，全局统一） */
export function nowMs(): number {
  return Date.now();
}

/** 基于 UTC+8 的"今天"路径 YYYY/MM/DD（与原版 build_file_path 一致） */
export function todayPath(now: number = Date.now()): string {
  const d = new Date(now + TZ_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** 口令字符集与原版 r_s 一致：大写字母 + 数字 */
const R_S = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** 5 位随机大写字母数字串（原版 get_random_string） */
export function randomString(len = 5): string {
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += R_S[buf[i] % R_S.length];
  return out;
}

/** 5 位随机数字（原版 get_random_num：10000~99999） */
export function randomNum(): number {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  return 10000 + (buf[0] % 90000);
}

/** 文件名校验与清洗（对齐原版 sanitize_filename） */
export function sanitizeFilename(filename: string): string {
  // 只保留 basename（兼容 / 与 \ 分隔）
  let cleaned = String(filename || "").replace(/^.*[\\/]/, "");
  // 替换非法字符与控制字符
  cleaned = cleaned.replace(/[\\/*?:"<>|\x00-\x1F]/g, "_");
  cleaned = cleaned.replace(/ /g, "_");
  cleaned = cleaned.replace(/_+/g, "_");
  cleaned = cleaned.replace(/^[._]+|[._]+$/g, "");
  if (!cleaned) cleaned = "unnamed_file";
  return cleaned.slice(0, 255);
}

/** 文件名拆分为 prefix（不含扩展名）与 suffix（含点扩展名），对齐 os.path.splitext */
export function splitExt(filename: string): [string, string] {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return [filename, ""];
  return [filename.slice(0, idx), filename.slice(idx)];
}

/** SHA-256 十六进制摘要 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 十六进制摘要 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** base64url 编码（无填充），与 Python urlsafe_b64encode(...).rstrip("=") 等价 */
export function base64UrlEncode(input: string | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = input;
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url 解码（兼容带填充与标准 base64） */
export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 常量时间字符串比较（对齐 hmac.compare_digest） */
export function compareDigest(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 下载鉴权 token：sha256(code + timeFactor + "000" + jwt_secret)，窗口约 1000 秒 */
export async function getSelectToken(code: string, secret: string, offset = 0): Promise<string> {
  const timeFactor = Math.floor(Date.now() / 1000) - Math.max(0, offset);
  return sha256Hex(`${code}${timeFactor}000${secret}`);
}

/** 过期信息计算（对齐原版 get_expire_info）。
 * 返回 { expiredAt: ISO 或 null, expiredCount, usedCount }
 */
export function getExpireInfo(
  expireValue: number,
  expireStyle: string,
  maxSaveSeconds: number
): { expiredAt: string | null; expiredCount: number; usedCount: number } {
  const now = Date.now();
  const maxSave = maxSaveSeconds > 0 ? maxSaveSeconds : 7 * 24 * 3600 * 1000;

  let expiredAt: string | null = null;
  let expiredCount = -1;
  const usedCount = 0;

  switch (expireStyle) {
    case "day":
      expiredAt = new Date(now + expireValue * 24 * 3600 * 1000).toISOString();
      break;
    case "hour":
      expiredAt = new Date(now + expireValue * 3600 * 1000).toISOString();
      break;
    case "minute":
      expiredAt = new Date(now + expireValue * 60 * 1000).toISOString();
      break;
    case "count":
      expiredAt = new Date(now + 24 * 3600 * 1000).toISOString();
      expiredCount = expireValue;
      break;
    case "forever":
      expiredAt = null;
      break;
    default:
      expiredAt = new Date(now + 24 * 3600 * 1000).toISOString();
  }

  if (expiredAt && new Date(expiredAt).getTime() - now > maxSave) {
    throw new ShareError(403, `限制最长时间为 ${formatDuration(maxSave)}，可换用其他方式`);
  }
  return { expiredAt, expiredCount, usedCount };
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / (24 * 3600 * 1000));
  const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  const minutes = Math.floor((ms % (3600 * 1000)) / (60 * 1000));
  const parts: string[] = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分钟`);
  if (!parts.length) parts.push(`${Math.floor(ms / 1000)}秒`);
  return parts.join("");
}

/** 业务错误：携带 HTTP 状态码，渲染为统一 API 错误响应 */
export class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 过期判断（对齐 FileCodes.is_expired） */
export function isExpired(expiredAt: string | null, expiredCount: number): boolean {
  if (expiredCount === 0) return true;
  if (expiredCount > 0) return false; // 次数型：以次数为准（used_count 由取件时扣减）
  if (expiredCount < 0) {
    if (!expiredAt) return false;
    return new Date(expiredAt).getTime() < Date.now();
  }
  return false;
}
