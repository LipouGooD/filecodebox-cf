// 分享核心业务：文本/文件上传、取件、元数据、下载
// 对齐原版 apps/base/views.py + apps/base/services.py

import {
  getExpireInfo,
  getSelectToken,
  isExpired,
  nowMs,
  sanitizeFilename,
  ShareError,
  splitExt,
  todayPath,
  compareDigest,
} from "./util";
import { Env, SiteConfig, generateUniqueCode, loadConfig } from "./config";
import { okResponse, errorResponse } from "./respond";

export interface FileCodeRow {
  id: number;
  code: string;
  prefix: string;
  suffix: string;
  uuid_file_name: string | null;
  file_path: string | null;
  size: number;
  text: string | null;
  expired_at: string | null;
  expired_count: number;
  used_count: number;
  created_at: string;
  file_hash: string | null;
  is_chunked: number | null;
  upload_id: string | null;
}

const TEXT_MAX_SIZE = 222 * 1024; // 与原版一致

// ---------- 建分享记录 ----------

async function insertFileCode(
  env: Env,
  row: Omit<FileCodeRow, "id" | "used_count" | "created_at" | "file_hash" | "is_chunked" | "upload_id">
): Promise<void> {
  await env.FILEBOX_DB.prepare(
    `INSERT INTO file_codes
       (code, prefix, suffix, uuid_file_name, file_path, size, text, expired_at, expired_count, used_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      row.code,
      row.prefix,
      row.suffix,
      row.uuid_file_name,
      row.file_path,
      row.size,
      row.text,
      row.expired_at,
      row.expired_count
    )
    .run();
}

/** 文本分享（POST /share/text/） */
export async function createTextShare(
  env: Env,
  config: SiteConfig,
  form: FormData
): Promise<Response> {
  const text = String(form.get("text") || "");
  const expireValue = Number(form.get("expire_value") || 1);
  const expireStyle = String(form.get("expire_style") || "day");
  validateExpireStyle(config, expireStyle);

  const textSize = new TextEncoder().encode(text).length;
  if (textSize > TEXT_MAX_SIZE) {
    return errorResponse(403, "内容过多,建议采用文件形式");
  }
  const { expiredAt, expiredCount, usedCount } = getExpireInfo(
    expireValue,
    expireStyle,
    Number(config.max_save_seconds)
  );
  const code = await generateUniqueCode(env, String(config.code_generate_type));
  await insertFileCode(env, {
    code,
    prefix: "Text",
    suffix: "",
    uuid_file_name: null,
    file_path: null,
    size: textSize,
    text,
    expired_at: expiredAt,
    expired_count: expiredCount,
  });
  return okResponse({ code });
}

/** 文件上传（POST /share/file/） multipart: file, expire_value, expire_style */
export async function createFileShare(
  env: Env,
  config: SiteConfig,
  form: FormData
): Promise<Response> {
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(400, "缺少文件字段");
  const expireValue = Number(form.get("expire_value") || 1);
  const expireStyle = String(form.get("expire_style") || "day");
  validateExpireStyle(config, expireStyle);

  const maxSize = Number(config.upload_size);
  if (file.size > maxSize) {
    return errorResponse(403, `大小超过限制,最大为${(maxSize / (1024 * 1024)).toFixed(2)} MB`);
  }
  const fileName = sanitizeFilename(file.name);
  validateFileType(config, fileName);

  const { expiredAt, expiredCount, usedCount } = getExpireInfo(
    expireValue,
    expireStyle,
    Number(config.max_save_seconds)
  );
  const code = await generateUniqueCode(env, String(config.code_generate_type));
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const filePath = `share/data/${todayPath()}/${uuid}`;
  const savePath = `${filePath}/${fileName}`;
  const [prefix, suffix] = splitExt(fileName);

  await env.FILEBOX_FILES.put(savePath, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  try {
    await insertFileCode(env, {
      code,
      prefix,
      suffix,
      uuid_file_name: fileName,
      file_path: filePath,
      size: file.size,
      text: null,
      expired_at: expiredAt,
      expired_count: expiredCount,
    });
  } catch (e) {
    // 建记录失败则回滚已存文件（对齐原版 rollback_saved_file）
    await env.FILEBOX_FILES.delete(savePath).catch(() => undefined);
    throw e;
  }
  return okResponse({ code, name: file.name });
}

function validateExpireStyle(config: SiteConfig, style: string): void {
  const allowed = (config.expire_style as string[]) || [];
  if (!allowed.includes(style)) throw new ShareError(400, "过期时间类型错误");
}

/** 文件类型校验（allowed_file_types 非通配时检查扩展名） */
function validateFileType(config: SiteConfig, fileName: string): void {
  const allowed = (config.allowed_file_types as string[]) || [];
  if (allowed.length === 1 && allowed[0] === "*") return;
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!allowed.some((t) => t.toLowerCase() === ext.toLowerCase())) {
    throw new ShareError(403, `不支持的文件类型: ${ext || "无扩展名"}`);
  }
}

// ---------- 查询与元数据 ----------

export async function findCode(env: Env, code: string): Promise<FileCodeRow | null> {
  const normalized = String(code || "").trim();
  if (!normalized) return null;
  return await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE code = ? LIMIT 1")
    .bind(normalized)
    .first<FileCodeRow>();
}

export function buildFileMetadata(row: FileCodeRow): Record<string, unknown> {
  const isText = row.text !== null;
  const remaining =
    row.expired_count > 0 ? row.expired_count : null;
  return {
    code: row.code,
    name: row.prefix + row.suffix,
    size: row.size,
    type: isText ? "text" : "file",
    is_text: isText,
    created_at: row.created_at,
    expired_at: row.expired_at,
    expired_count: row.expired_count,
    used_count: row.used_count,
    remaining_downloads: remaining,
  };
}

/** POST /share/metadata/ */
export async function metadata(env: Env, body: { code?: string }): Promise<Response> {
  const row = await findCode(env, body.code || "");
  if (!row) return errorResponse(404, "文件不存在");
  if (isExpired(row.expired_at, row.expired_count)) return errorResponse(404, "文件已过期");
  return okResponse(buildFileMetadata(row));
}

// ---------- 取件 ----------

/** 原子消费一次领取次数；失败返回 false（对齐 consume_file_usage） */
async function consumeUsage(env: Env, id: number): Promise<boolean> {
  const res = await env.FILEBOX_DB.prepare(
    `UPDATE file_codes
     SET expired_count = CASE WHEN expired_count > 0 THEN expired_count - 1 ELSE expired_count END,
         used_count = used_count + 1
     WHERE id = ? AND (
       expired_count > 0
       OR (expired_count < 0 AND (expired_at IS NULL OR expired_at > ?))
     )`
  )
    .bind(id, new Date(nowMs()).toISOString())
    .run();
  return res.meta.changes > 0;
}

/** 构建 select 详情（对齐 build_select_detail）：CF 下统一走代理下载 */
async function buildSelectDetail(
  env: Env,
  config: SiteConfig,
  row: FileCodeRow
): Promise<Record<string, unknown>> {
  const metadata = buildFileMetadata(row);
  if (row.text !== null) {
    return { ...metadata, text: row.text, content: row.text, download_url: null };
  }
  // 文件分享：download_url 一律用代理下载地址（R2 直链需开放 bucket，默认不开放）
  const token = await getSelectToken(row.code, String(config.jwt_secret));
  const downloadUrl = `/share/download?key=${token}&code=${encodeURIComponent(row.code)}`;
  return { ...metadata, text: downloadUrl, content: null, download_url: downloadUrl };
}

/** POST /share/select/：返回 JSON（含文本内容或下载地址） */
export async function selectJson(env: Env, config: SiteConfig, body: { code?: string }): Promise<Response> {
  const row = await findCode(env, body.code || "");
  if (!row) return errorResponse(404, "文件不存在");
  if (isExpired(row.expired_at, row.expired_count)) return errorResponse(404, "文件已过期");

  // 原版：非"次数型且走下载"的情况下先消费；CF 全部走代理下载，故在下载动作处消费。
  // 这里保持与 download 一致的语义：返回详情不消费，下载时消费。
  const detail = await buildSelectDetail(env, config, row);
  return okResponse(detail);
}

/** 文本分享的取件：直接返回文本文件（对齐 GET /share/select/ 的文本分支） */
function textDownloadResponse(row: FileCodeRow): Response {
  const filename = `${row.prefix || "Text"}${row.suffix || ".txt"}`;
  return new Response(row.text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** R2 文件下载响应 */
async function r2DownloadResponse(env: Env, row: FileCodeRow): Promise<Response> {
  if (!row.file_path || !row.uuid_file_name) return errorResponse(404, "文件不存在");
  const key = `${row.file_path}/${row.uuid_file_name}`;
  const obj = await env.FILEBOX_FILES.get(key);
  if (!obj) return errorResponse(404, "文件已过期删除");
  const filename = row.prefix + row.suffix;
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** 通用取件（GET /share/select/?code= 与 GET /download/{code} 共用）：消费一次并返回文件流 */
export async function selectDownload(env: Env, config: SiteConfig, code: string): Promise<Response> {
  const row = await findCode(env, code);
  if (!row) return errorResponse(404, "文件不存在");
  if (isExpired(row.expired_at, row.expired_count)) return errorResponse(404, "文件已过期");
  if (!(await consumeUsage(env, row.id))) return errorResponse(404, "文件已过期");
  if (row.text !== null) return textDownloadResponse(row);
  return r2DownloadResponse(env, row);
}

/** GET /share/download?key=&code=：token 鉴权后消费并下载 */
export async function downloadWithToken(
  env: Env,
  config: SiteConfig,
  params: URLSearchParams
): Promise<Response> {
  const key = params.get("key") || "";
  const code = String(params.get("code") || "").trim();
  if (!key || !code) return errorResponse(403, "下载鉴权失败");
  const secret = String(config.jwt_secret);
  const validKeys = [await getSelectToken(code, secret, 0), await getSelectToken(code, secret, 1)];
  if (!validKeys.some((candidate) => compareDigest(key, candidate))) {
    return errorResponse(403, "下载鉴权失败");
  }
  return selectDownload(env, config, code);
}

// ---------- 预签名上传（proxy 模式，对齐原版 apps/base/views.py presign_api）----------
// R2 binding 无法生成外部可用的预签名直传 URL，故统一走 proxy：init 建会话 → PUT 转存 → 返回取件码

const PRESIGN_SESSION_EXPIRES_SEC = 900; // 与原版一致：15 分钟

interface PresignSession {
  file_name: string;
  file_size: number;
  file_path: string;
  save_path: string;
  expire_value: number;
  expire_style: string;
  created_at: number;
}

function sessionKey(uploadId: string): string {
  return `presign:${uploadId}`;
}

async function loadPresignSession(env: Env, uploadId: string): Promise<PresignSession | null> {
  const row = await env.FILEBOX_DB.prepare("SELECT value FROM key_value WHERE key = ? LIMIT 1")
    .bind(sessionKey(uploadId))
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PresignSession;
  } catch {
    return null;
  }
}

async function savePresignSession(env: Env, uploadId: string, session: PresignSession): Promise<void> {
  await env.FILEBOX_DB.prepare(
    "INSERT INTO key_value(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(sessionKey(uploadId), JSON.stringify(session))
    .run();
}

async function deletePresignSession(env: Env, uploadId: string): Promise<void> {
  await env.FILEBOX_DB.prepare("DELETE FROM key_value WHERE key = ?").bind(sessionKey(uploadId)).run();
}

/** POST /presign/upload/init：创建上传会话（始终返回 proxy 模式） */
export async function presignInit(
  env: Env,
  config: SiteConfig,
  body: { file_name?: string; file_size?: number; expire_value?: number; expire_style?: string }
): Promise<Response> {
  const fileName = sanitizeFilename(String(body.file_name || ""));
  if (!fileName) return errorResponse(400, "缺少文件名称");
  const fileSize = Number(body.file_size || 0);
  if (fileSize <= 0) return errorResponse(400, "文件大小错误");
  const expireValue = Number(body.expire_value || 1);
  const expireStyle = String(body.expire_style || "day");
  validateExpireStyle(config, expireStyle);
  validateFileType(config, fileName);

  const maxSize = Number(config.upload_size);
  if (fileSize > maxSize) {
    return errorResponse(403, `文件大小超过限制,最大为${(maxSize / (1024 * 1024)).toFixed(2)} MB`);
  }

  const uploadId = crypto.randomUUID().replace(/-/g, "");
  const filePath = `share/data/${todayPath()}/${uploadId}`;
  const savePath = `${filePath}/${fileName}`;
  await savePresignSession(env, uploadId, {
    file_name: fileName,
    file_size: fileSize,
    file_path: filePath,
    save_path: savePath,
    expire_value: expireValue,
    expire_style: expireStyle,
    created_at: nowMs(),
  });

  const proxyUploadUrl = `/presign/upload/proxy/${uploadId}`;
  return okResponse({
    upload_id: uploadId,
    upload_url: proxyUploadUrl,
    mode: "proxy",
    expires_in: PRESIGN_SESSION_EXPIRES_SEC,
    proxy_upload_url: proxyUploadUrl,
    legacy_proxy_upload_url: `/api${proxyUploadUrl}`,
  });
}

/** PUT /presign/upload/proxy/{upload_id}：代理转存文件并创建分享记录 */
export async function presignProxyUpload(
  env: Env,
  config: SiteConfig,
  uploadId: string,
  request: Request
): Promise<Response> {
  const session = await loadPresignSession(env, uploadId);
  if (!session) return errorResponse(404, "上传会话不存在或已过期");
  if (nowMs() - session.created_at > PRESIGN_SESSION_EXPIRES_SEC * 1000) {
    await deletePresignSession(env, uploadId);
    return errorResponse(404, "上传会话不存在或已过期");
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(400, "缺少文件字段");
  const maxSize = Number(config.upload_size);
  if (file.size > maxSize) {
    return errorResponse(403, `大小超过限制,最大为${(maxSize / (1024 * 1024)).toFixed(2)} MB`);
  }

  const fileName = session.file_name;
  await env.FILEBOX_FILES.put(session.save_path, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  const { expiredAt, expiredCount, usedCount } = getExpireInfo(
    session.expire_value,
    session.expire_style,
    Number(config.max_save_seconds)
  );
  const code = await generateUniqueCode(env, String(config.code_generate_type));
  const [prefix, suffix] = splitExt(fileName);
  try {
    await insertFileCode(env, {
      code,
      prefix,
      suffix,
      uuid_file_name: fileName,
      file_path: session.file_path,
      size: file.size,
      text: null,
      expired_at: expiredAt,
      expired_count: expiredCount,
    });
  } catch (e) {
    await env.FILEBOX_FILES.delete(session.save_path).catch(() => undefined);
    throw e;
  }
  await deletePresignSession(env, uploadId);
  return okResponse({ code, name: fileName });
}

/** GET /presign/upload/status/{upload_id}：查询会话状态 */
export async function presignStatus(env: Env, uploadId: string): Promise<Response> {
  const session = await loadPresignSession(env, uploadId);
  if (!session) return errorResponse(404, "上传会话不存在");
  const isExpired = nowMs() - session.created_at > PRESIGN_SESSION_EXPIRES_SEC * 1000;
  return okResponse({
    upload_id: uploadId,
    file_name: session.file_name,
    file_size: session.file_size,
    mode: "proxy",
    created_at: new Date(session.created_at).toISOString(),
    expires_at: new Date(session.created_at + PRESIGN_SESSION_EXPIRES_SEC * 1000).toISOString(),
    is_expired: isExpired,
  });
}

/** DELETE /presign/upload/{upload_id}：取消会话 */
export async function presignCancel(env: Env, uploadId: string): Promise<Response> {
  const session = await loadPresignSession(env, uploadId);
  if (!session) return errorResponse(404, "上传会话不存在");
  await deletePresignSession(env, uploadId);
  return okResponse({ message: "上传会话已取消" });
}

// ---------- 定时清理（对齐 tasks.delete_expire_files） ----------

export async function cleanExpiredFiles(env: Env): Promise<{ removed: number; freed: number }> {
  const now = new Date(nowMs()).toISOString();
  const rows = await env.FILEBOX_DB.prepare(
    "SELECT * FROM file_codes WHERE (expired_at IS NOT NULL AND expired_at < ?) OR expired_count = 0"
  )
    .bind(now)
    .all<FileCodeRow>();

  let removed = 0;
  let freed = 0;
  for (const row of rows.results) {
    try {
      if (row.file_path && row.uuid_file_name) {
        const key = `${row.file_path}/${row.uuid_file_name}`;
        const obj = await env.FILEBOX_FILES.head(key);
        if (obj) {
          await env.FILEBOX_FILES.delete(key);
          freed += obj.size;
        }
      }
      await env.FILEBOX_DB.prepare("DELETE FROM file_codes WHERE id = ?").bind(row.id).run();
      removed++;
    } catch {
      // 单条失败不阻断整体清理
    }
  }
  return { removed, freed };
}
