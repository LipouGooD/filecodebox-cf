// 管理后台：登录/验证/仪表盘/文件管理/配置管理
// 对齐原版 apps/admin/views.py；CF 迁移版砍掉：分片、预签名、本地文件、健康洞察、活动记录

import {
  Env,
  SiteConfig,
  loadConfig,
  saveConfig,
  buildPublicConfig,
  isInitialized,
  hashPassword,
  verifyPassword,
} from "./config";
import { createToken, requireAdmin } from "./auth";
import { errorResponse, okResponse } from "./respond";
import { FileCodeRow, findCode } from "./share";
import { isExpired, ShareError } from "./util";

// ---------- 认证 ----------

export async function login(
  env: Env,
  config: SiteConfig,
  body: { password?: string }
): Promise<Response> {
  const password = String(body.password || "");
  if (!(await verifyPassword(password, String(config.admin_token || "")))) {
    return errorResponse(401, "密码错误");
  }
  const expiresIn = normalizeSessionExpire(Number(config.admin_session_expire));
  const jwtSecret = String(config.jwt_secret);
  const token = await createToken(jwtSecret, { is_admin: true }, expiresIn);
  const payload = await verifyJwtForExpiry(jwtSecret, token);
  return okResponse({
    id: "admin",
    username: "admin",
    token,
    token_type: "Bearer",
    expires_at: payload.exp,
    expires_in: expiresIn,
  });
}

function normalizeSessionExpire(v: number): number {
  const d = 24 * 60 * 60; // 1 天
  if (!Number.isFinite(v)) return 30 * d;
  if (v < d || v > 365 * d) return 30 * d;
  return v;
}

async function verifyJwtForExpiry(jwtSecret: string, token: string): Promise<{ exp: number }> {
  // login 里 token 刚创建，直接解析 payload 取 exp（不重复验签）
  const payloadB64 = token.split(".")[1];
  if (!payloadB64) throw new ShareError(401, "token验证失败");
  const payload = JSON.parse(new TextDecoder().decode(
    base64urlBytes(payloadB64)
  )) as { exp: number };
  return payload;
}

function base64urlBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function verify(env: Env, config: SiteConfig, authorization: string | null): Promise<Response> {
  const payload = await requireAdmin(String(config.jwt_secret), authorization);
  return okResponse(payload);
}

// ---------- 仪表盘（简化版，字段对齐原版） ----------

export async function dashboard(env: Env, config: SiteConfig): Promise<Response> {
  const all = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes").all<FileCodeRow>();
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  todayStart.setTime(todayStart.getTime() - 8 * 3600 * 1000); // UTC+8 的今天零点

  const rows = all.results;
  let totalFiles = rows.length;
  let storageUsed = 0;
  let usedCount = 0;
  let expiredCount = 0;
  let textCount = 0;
  let todayCount = 0;
  const suffixCounter = new Map<string, number>();

  for (const row of rows) {
    storageUsed += row.size;
    usedCount += row.used_count;
    if (isExpired(row.expired_at, row.expired_count)) expiredCount++;
    if (row.text !== null) textCount++;
    if (new Date(row.created_at).getTime() >= todayStart.getTime()) todayCount++;
    if (row.text === null && row.suffix) {
      const s = row.suffix || "file";
      suffixCounter.set(s, (suffixCounter.get(s) || 0) + 1);
    }
  }

  const recent = rows
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8)
    .map((r) => buildAdminItem(r));

  const topSuffixes = [...suffixCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([suffix, count]) => ({ suffix, count }));

  return okResponse({
    total_files: totalFiles,
    storage_used: String(storageUsed),
    sys_uptime: null,
    yesterday_count: 0,
    yesterday_size: "0",
    today_count: todayCount,
    today_size: "0",
    active_count: totalFiles - expiredCount,
    expired_count: expiredCount,
    text_count: textCount,
    file_count: totalFiles - textCount,
    chunked_count: 0,
    used_count: usedCount,
    storage_backend: "r2",
    upload_size_limit: config.upload_size,
    open_upload: config.open_upload,
    enable_chunk: 0,
    max_save_seconds: config.max_save_seconds,
    health_summary: emptyHealthSummary(),
    top_suffixes: topSuffixes,
    recent_files: recent,
    recent_activities: [],
  });
}

function emptyHealthSummary(): Record<string, number> {
  return {
    health_attention_count: 0,
    health_danger_count: 0,
    health_warning_count: 0,
    expiring_soon_count: 0,
    storage_issue_count: 0,
    never_retrieved_count: 0,
    healthy_count: 0,
    permanent_count: 0,
  };
}

/** 管理列表条目（对齐 _build_admin_file_item 核心字段） */
export function buildAdminItem(row: FileCodeRow): Record<string, unknown> {
  const isText = row.text !== null;
  const expired = isExpired(row.expired_at, row.expired_count);
  const name = row.prefix + row.suffix;
  const remaining =
    row.expired_count >= 0 ? Math.max(row.expired_count, 0) : null;
  return {
    id: row.id,
    code: row.code,
    prefix: row.prefix,
    suffix: row.suffix,
    uuid_file_name: row.uuid_file_name,
    file_path: row.file_path,
    size: row.size || 0,
    text: row.text,
    expired_at: row.expired_at,
    expired_count: row.expired_count,
    used_count: row.used_count,
    created_at: row.created_at,
    file_hash: row.file_hash,
    is_chunked: row.is_chunked === 1,
    upload_id: row.upload_id,
    is_local_ref: false,
    name,
    type: isText ? "text" : "file",
    status: expired ? "expired" : "active",
    is_text: isText,
    is_expired: expired,
    remaining_downloads: remaining,
  };
}

// ---------- 文件列表 ----------

export async function fileList(
  env: Env,
  params: URLSearchParams
): Promise<Response> {
  let page = Math.max(Number(params.get("page") || 1) || 1, 1);
  let size = Math.min(Math.max(Number(params.get("size") || 10) || 10, 1), 100);
  const keyword = (params.get("keyword") || "").trim().toLowerCase();
  const status = (params.get("status") || "").trim().toLowerCase();
  const fileType = (params.get("type") || "").trim().toLowerCase();
  const sortBy = params.get("sort_by") || "created_at";
  const sortOrder = (params.get("sort_order") || "desc").toLowerCase();

  const all = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes").all<FileCodeRow>();
  let rows = all.results;

  let totalFiles = rows.length;
  let expiredCount = 0;
  let textCount = 0;
  let storageUsed = 0;

  const enriched: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    storageUsed += row.size;
    const item = buildAdminItem(row);
    if (item.is_expired) expiredCount++;
    if (item.is_text) textCount++;
    // 过滤
    if (status && item.status !== status) continue;
    if (fileType && item.type !== fileType) continue;
    if (keyword) {
      const haystack = `${item.code} ${item.name} ${row.text || ""}`.toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }
    enriched.push(item);
  }

  const sortVal = (item: Record<string, unknown>): number | string => {
    const v = item[sortBy];
    return typeof v === "number" ? v : String(v ?? "");
  };
  enriched.sort((a, b) => {
    const va = sortVal(a);
    const vb = sortVal(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortOrder === "asc" ? cmp : -cmp;
  });

  const start = (page - 1) * size;
  const data = enriched.slice(start, start + size);
  return okResponse({
    page,
    size,
    data,
    total: enriched.length,
    summary: {
      total_files: totalFiles,
      active_count: totalFiles - expiredCount,
      expired_count: expiredCount,
      text_count: textCount,
      file_count: totalFiles - textCount,
      chunked_count: 0,
      storage_used: storageUsed,
      used_count: rows.reduce((s, r) => s + r.used_count, 0),
      ...emptyHealthSummary(),
    },
  });
}

// ---------- 文件详情 / 删除 / 下载 / 预览 ----------

export async function fileDetail(env: Env, id: number): Promise<Response> {
  const row = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<FileCodeRow>();
  if (!row) return errorResponse(404, "文件不存在");
  const item = buildAdminItem(row);
  return okResponse({
    ...item,
    filename: item.name,
    display_name: item.name,
    text_length: row.text ? row.text.length : 0,
    can_download: row.text !== null || Boolean(row.file_path && row.uuid_file_name),
    is_permanent: row.expired_at === null && row.expired_count < 0,
    status_insights: { severity: "ok", reasons: [] },
    timeline: [],
  });
}

export async function deleteFile(env: Env, id: number): Promise<Response> {
  const row = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<FileCodeRow>();
  if (!row) return errorResponse(404, "文件不存在");
  if (row.file_path && row.uuid_file_name) {
    await env.FILEBOX_FILES.delete(`${row.file_path}/${row.uuid_file_name}`).catch(() => undefined);
  }
  await env.FILEBOX_DB.prepare("DELETE FROM file_codes WHERE id = ?").bind(id).run();
  return okResponse(null);
}

export async function batchDelete(env: Env, ids: number[]): Promise<Response> {
  if (!ids || !ids.length) return errorResponse(400, "请选择要删除的文件");
  let success = 0;
  for (const id of ids) {
    try {
      const row = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE id = ? LIMIT 1")
        .bind(id)
        .first<FileCodeRow>();
      if (!row) continue;
      if (row.file_path && row.uuid_file_name) {
        await env.FILEBOX_FILES.delete(`${row.file_path}/${row.uuid_file_name}`).catch(() => undefined);
      }
      await env.FILEBOX_DB.prepare("DELETE FROM file_codes WHERE id = ?").bind(id).run();
      success++;
    } catch {
      // 单个失败跳过
    }
  }
  return okResponse({ success, failed: ids.length - success });
}

/** 管理后台文件下载（GET /admin/file/download?id=） */
export async function adminDownload(env: Env, id: number): Promise<Response> {
  const row = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<FileCodeRow>();
  if (!row) return errorResponse(404, "文件不存在");
  if (row.text !== null) {
    const filename = `${row.prefix || "Text"}${row.suffix || ".txt"}`;
    return new Response(row.text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  }
  if (!row.file_path || !row.uuid_file_name) return errorResponse(404, "文件不存在");
  const obj = await env.FILEBOX_FILES.get(`${row.file_path}/${row.uuid_file_name}`);
  if (!obj) return errorResponse(404, "文件已过期删除");
  const filename = row.prefix + row.suffix;
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

/** 文本预览（文件类型返回不支持提示） */
export async function adminPreview(env: Env, id: number, maxChars: number): Promise<Response> {
  const row = await env.FILEBOX_DB.prepare("SELECT * FROM file_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<FileCodeRow>();
  if (!row) return errorResponse(404, "文件不存在");
  if (row.text === null) {
    return errorResponse(400, "该功能在 Cloudflare 迁移版不可用（仅支持文本预览）");
  }
  const text = row.text;
  const truncated = text.length > maxChars;
  return okResponse({
    id: row.id,
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
    total_length: text.length,
  });
}

// ---------- 配置 ----------

/** 管理配置读取：隐藏密钥原文 */
export async function adminConfigGet(env: Env): Promise<Response> {
  const config = await loadConfig(env);
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "admin_token" || key === "jwt_secret") continue;
    safe[key] = value;
  }
  safe.admin_initialized = isInitialized(config);
  return okResponse(safe);
}

export async function adminConfigUpdate(env: Env, patch: Record<string, unknown>): Promise<Response> {
  await saveConfig(env, patch || {});
  return okResponse(null);
}

// ---------- 视图预设（存 D1 key_value，简单实现） ----------

const VIEW_PRESETS_KEY = "admin_view_presets";

export async function viewPresetsGet(env: Env): Promise<Response> {
  const row = await env.FILEBOX_DB.prepare("SELECT value FROM key_value WHERE key = ?")
    .bind(VIEW_PRESETS_KEY)
    .first<{ value: string | null }>();
  const list = row?.value ? JSON.parse(row.value) : [];
  return okResponse(list);
}

export async function viewPresetsSave(env: Env, body: { id?: string; name?: string; filters?: unknown }): Promise<Response> {
  const existing = await viewPresetsGetRaw(env);
  const preset = {
    id: body.id || crypto.randomUUID(),
    name: String(body.name || "未命名视图"),
    filters: body.filters || {},
  };
  const idx = existing.findIndex((p: { id?: string }) => p.id === preset.id);
  if (idx >= 0) existing[idx] = preset;
  else existing.push(preset);
  await env.FILEBOX_DB.prepare(
    "INSERT INTO key_value (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(VIEW_PRESETS_KEY, JSON.stringify(existing))
    .run();
  return okResponse(preset);
}

export async function viewPresetsDelete(env: Env, id: string): Promise<Response> {
  const existing = await viewPresetsGetRaw(env);
  const filtered = existing.filter((p: { id?: string }) => p.id !== id);
  await env.FILEBOX_DB.prepare(
    "INSERT INTO key_value (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(VIEW_PRESETS_KEY, JSON.stringify(filtered))
    .run();
  return okResponse(null);
}

async function viewPresetsGetRaw(env: Env): Promise<Array<Record<string, unknown>>> {
  const row = await env.FILEBOX_DB.prepare("SELECT value FROM key_value WHERE key = ?")
    .bind(VIEW_PRESETS_KEY)
    .first<{ value: string | null }>();
  return row?.value ? JSON.parse(row.value) : [];
}
