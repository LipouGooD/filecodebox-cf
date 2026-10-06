// 站点配置：默认值、D1 读写、初始化、公共配置构建
// 对齐原版 core/settings.py DEFAULT_CONFIG + apps/base/config.py + setup_wizard.build_public_config

import { base64UrlEncode, hmacSha256Hex, randomString, randomNum, ShareError } from "./util";
import { setupRequiredResponse } from "./respond";

export interface Env {
  FILEBOX_DB: D1Database;
  FILEBOX_FILES: R2Bucket;
}

// 与原版 DEFAULT_CONFIG 对齐；仅保留 CF 迁移支持的配置项
export const DEFAULT_CONFIG: Record<string, unknown> = {
  file_storage: "r2",
  name: "文件快递柜 - FileCodeBox",
  description: "开箱即用的文件快传系统",
  notify_title: "系统通知",
  notify_content:
    '欢迎使用 FileCodeBox，本程序开源于 <a href="https://github.com/vastsa/FileCodeBox" target="_blank">Github</a> ，欢迎Star和Fork。',
  page_explain:
    "请勿上传或分享违法内容。根据《中华人民共和国网络安全法》、《中华人民共和国刑法》、《中华人民共和国治安管理处罚法》等相关规定。 传播或存储违法、违规内容，会受到相关处罚，严重者将承担刑事责任。本站坚决配合相关部门，确保网络内容的安全，和谐，打造绿色网络环境。",
  keywords: "FileCodeBox, 文件快递柜, 口令传送箱, 匿名口令分享文本, 文件",
  admin_token: "",
  jwt_secret: "",
  admin_session_expire: 30 * 24 * 60 * 60, // 30 天
  open_upload: 1,
  upload_size: 1024 * 1024 * 10, // 10MB
  allowed_file_types: ["*"],
  expire_style: ["day", "hour", "minute", "forever", "count"],
  code_generate_type: "secret", // secret | number
  upload_minute: 1,
  upload_count: 10,
  max_save_seconds: 0, // 0 = 不限，默认 7 天上限
  enable_chunk: 0, // CF 迁移不支持分片上传，固定 0
  opacity: 0.9,
  background: "",
  themes_select: "themes/2024",
  show_admin_addr: 0,
};

export type SiteConfig = typeof DEFAULT_CONFIG;

const SETTINGS_KEY = "settings";

export async function loadConfig(env: Env): Promise<SiteConfig> {
  const row = await env.FILEBOX_DB.prepare("SELECT value FROM key_value WHERE key = ?")
    .bind(SETTINGS_KEY)
    .first<{ value: string | null }>();
  const stored = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  return { ...DEFAULT_CONFIG, ...stored };
}

/** 是否已完成初始化（设置过管理员密码） */
export function isInitialized(config: SiteConfig): boolean {
  return Boolean(config.admin_token) && Boolean(config.jwt_secret);
}

/** 中间件式检查：未初始化时返回 428 响应，否则 null */
export async function requireInitialized(env: Env): Promise<Response | null> {
  const config = await loadConfig(env);
  if (!isInitialized(config)) return setupRequiredResponse();
  return null;
}

/** 初始化系统：写入管理员密码哈希 + JWT 密钥（对齐 initialize_system） */
export async function initializeSystem(
  env: Env,
  adminPassword: string,
  siteName?: string
): Promise<SiteConfig> {
  const password = String(adminPassword || "").trim();
  if (password.length < 8) {
    throw new ShareError(400, "管理员密码至少需要 8 位");
  }
  const config = await loadConfig(env);
  if (isInitialized(config)) {
    throw new ShareError(400, "系统已经初始化，请直接登录后台");
  }

  const next: SiteConfig = { ...config };
  next.admin_token = await hashPassword(password);
  if (!next.jwt_secret) next.jwt_secret = await generateJwtSecret();
  if (siteName && siteName.trim()) next.name = siteName.trim().slice(0, 80);

  await env.FILEBOX_DB.prepare(
    "INSERT INTO key_value (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(SETTINGS_KEY, JSON.stringify(next))
    .run();
  return next;
}

/** 保存配置（管理后台调用；对齐 admin config update 的合并语义） */
export async function saveConfig(env: Env, patch: Record<string, unknown>): Promise<SiteConfig> {
  const config = await loadConfig(env);
  // 白名单：只允许更新可安全修改的配置项
  const ALLOWED = new Set([
    "name",
    "description",
    "notify_title",
    "notify_content",
    "page_explain",
    "keywords",
    "background",
    "opacity",
    "open_upload",
    "upload_size",
    "allowed_file_types",
    "expire_style",
    "code_generate_type",
    "upload_minute",
    "upload_count",
    "max_save_seconds",
    "show_admin_addr",
  ]);
  const next: SiteConfig = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (ALLOWED.has(key)) (next as Record<string, unknown>)[key] = value;
  }
  await env.FILEBOX_DB.prepare(
    "INSERT INTO key_value (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(SETTINGS_KEY, JSON.stringify(next))
    .run();
  return next;
}

/** 公共配置（对齐 build_public_config + build_public_meta） */
export function buildPublicConfig(config: SiteConfig) {
  return {
    name: config.name,
    description: config.description,
    explain: config.page_explain,
    upload_size: config.upload_size,
    allowed_file_types: config.allowed_file_types,
    expire_style: config.expire_style,
    enable_chunk: 0,
    open_upload: config.open_upload,
    notify_title: config.notify_title,
    notify_content: config.notify_content,
    show_admin_address: Number(config.show_admin_addr) === 1,
    max_save_seconds: config.max_save_seconds,
  };
}

export function buildPublicMeta(config: SiteConfig) {
  return {
    version: "2.7.1-cf",
    api: {
      legacy_config: "/",
      public_config: "/api/v1/config",
      health: "/health",
    },
    features: {
      chunk_upload: false,
      guest_upload: Number(config.open_upload) === 1,
      admin_address_visible: Number(config.show_admin_addr) === 1,
      expiration_modes: config.expire_style,
    },
    limits: {
      upload_size: config.upload_size,
      allowed_file_types: config.allowed_file_types,
      max_save_seconds: config.max_save_seconds,
      upload_window_minutes: config.upload_minute,
      upload_window_count: config.upload_count,
    },
  };
}

// ---------- 密码哈希（PBKDF2-SHA256，替代原版 scrypt；格式 pbkdf2$<iter>$<salt>$<hash>） ----------
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = base64UrlEncode(saltBytes);
  const hash = await pbkdf2(password, saltBytes, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${base64UrlEncode(hash)}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  if (!hashed) return false;
  if (!hashed.startsWith("pbkdf2$")) return false;
  const parts = hashed.split("$");
  if (parts.length !== 4) return false;
  const [, iterStr, saltB64, hashB64] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  try {
    const salt = base64UrlDecodeSafe(saltB64);
    const expected = base64UrlDecodeSafe(hashB64);
    const actual = await pbkdf2(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

function base64UrlDecodeSafe(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 生成 JWT 密钥（32 字节随机，与 generate_jwt_secret 语义一致） */
export async function generateJwtSecret(): Promise<string> {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** 唯一口令生成：style = secret | number */
export async function generateUniqueCode(
  env: Env,
  style: string,
  retries = 50
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    const code = style === "number" ? String(randomNum()) : randomString(5);
    const row = await env.FILEBOX_DB.prepare("SELECT id FROM file_codes WHERE code = ? LIMIT 1")
      .bind(code)
      .first();
    if (!row) return code;
  }
  throw new ShareError(500, "口令生成失败，请重试");
}
