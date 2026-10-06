// JWT（HS256）：创建 / 验证，对齐原版 apps/base/auth.py create_token / verify_token
// 使用 Worker 内置 WebCrypto HMAC-SHA256

import { base64UrlEncode, base64UrlDecode, compareDigest, hmacSha256Hex, ShareError } from "./util";

export interface AdminSessionPayload {
  is_admin: boolean;
  exp: number;
}

/** 创建 JWT（HS256），payload 需为可 JSON 序列化对象 */
export async function createToken(
  jwtSecret: string,
  data: Record<string, unknown>,
  expiresInSeconds: number
): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = base64UrlEncode(JSON.stringify({ ...data, exp }));
  const signature = base64UrlEncode(await hmacSha256Hex(jwtSecret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

/** 验证 JWT，返回 payload；失败抛 ShareError(401) */
export async function verifyToken(jwtSecret: string, token: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ShareError(401, "token验证失败");
  const [headerB64, payloadB64, signatureB64] = parts;

  // 校验签名（常量时间比较，签名先还原为相同编码形式）
  const expectedSig = base64UrlEncode(await hmacSha256Hex(jwtSecret, `${headerB64}.${payloadB64}`));
  if (!compareDigest(signatureB64, expectedSig)) throw new ShareError(401, "无效的签名");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Record<string, unknown>;
  } catch {
    throw new ShareError(401, "token验证失败");
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new ShareError(401, "token已过期");
  }
  return payload;
}

/** 提取 Bearer token；缺失/格式错误抛 401 */
export function extractBearerToken(authorization: string | null): string {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new ShareError(401, "未授权或授权校验失败");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new ShareError(401, "未授权或授权校验失败");
  return token;
}

/** 管理后台鉴权：返回 payload；失败抛 401 */
export async function requireAdmin(
  jwtSecret: string,
  authorization: string | null
): Promise<Record<string, unknown>> {
  const token = extractBearerToken(authorization);
  const payload = await verifyToken(jwtSecret, token);
  if (payload.is_admin !== true) throw new ShareError(401, "未授权或授权校验失败");
  return payload;
}
