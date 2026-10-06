// FileCodeBox Cloudflare Workers 入口
// 路由 + CORS + 未初始化守卫 + 定时清理

import {
  Env,
  SiteConfig,
  loadConfig,
  initializeSystem,
  buildPublicConfig,
  buildPublicMeta,
  isInitialized,
} from "./config";
import {
  createTextShare,
  createFileShare,
  metadata,
  selectJson,
  selectDownload,
  downloadWithToken,
  cleanExpiredFiles,
  findCode,
  buildFileMetadata,
} from "./share";
import {
  login,
  verify,
  dashboard,
  fileList,
  fileDetail,
  deleteFile,
  batchDelete,
  adminDownload,
  adminPreview,
  adminConfigGet,
  adminConfigUpdate,
  viewPresetsGet,
  viewPresetsSave,
  viewPresetsDelete,
} from "./admin";
import { requireAdmin } from "./auth";
import { errorResponse, okResponse, setupRequiredResponse, jsonResponse } from "./respond";
import { ShareError } from "./util";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      let response = await route(request, env, path, url);
      // 附加 CORS 头
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (e) {
      if (e instanceof ShareError) {
        return jsonResponse(e.status, { code: e.status, message: e.message, detail: e.message }, CORS_HEADERS);
      }
      console.error("unhandled error:", e);
      return jsonResponse(500, { code: 500, message: "服务器内部错误", detail: "服务器内部错误" }, CORS_HEADERS);
    }
  },

  // 定时清理过期文件（每天 3 点 UTC）
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await cleanExpiredFiles(env);
    console.log(`清理完成: 删除 ${result.removed} 条记录, 释放 ${result.freed} 字节`);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  // ---- 公开端点（未初始化也可访问）----
  if (path === "/health" || path === "/health/") {
    return okResponse({ status: "ok", version: "2.7.1-cf", storage: "r2", theme: "themes/2024" });
  }
  if (path === "/setup" || path === "/setup/") {
    return handleSetup(request, env);
  }

  const config = await loadConfig(env);

  // ---- 未初始化守卫（对齐原版中间件：除 setup/health 外一律 428）----
  if (!isInitialized(config)) {
    return setupRequiredResponse();
  }

  // ---- 公共配置 ----
  if (path === "/" && request.method === "POST") {
    return okResponse(buildPublicConfig(config));
  }
  if (path === "/api/v1/config" && request.method === "GET") {
    return okResponse({ config: buildPublicConfig(config), meta: buildPublicMeta(config) });
  }

  // ---- 分享 API（/share/*）----
  if (path === "/share/text/" && request.method === "POST") {
    await guardUpload(config, request);
    return createTextShare(env, config, await request.formData());
  }
  if (path === "/share/file/" && request.method === "POST") {
    await guardUpload(config, request);
    return createFileShare(env, config, await request.formData());
  }
  if (path === "/share/metadata/" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { code?: string };
    return metadata(env, body);
  }
  if (path === "/share/select/" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { code?: string };
    return selectJson(env, config, body);
  }
  if (path === "/share/select" && request.method === "GET") {
    return selectDownload(env, config, url.searchParams.get("code") || "");
  }
  if (path === "/share/download" && request.method === "GET") {
    return downloadWithToken(env, config, url.searchParams);
  }

  // ---- 兼容残留路由：GET /file/{code}（文件信息）、GET /download/{code}（直接下载）----
  const fileMatch = path.match(/^\/file\/([^/]+)$/);
  if (fileMatch && request.method === "GET") {
    const row = await findCode(env, fileMatch[1]);
    if (!row) return errorResponse(404, "文件不存在");
    return okResponse(buildFileMetadata(row));
  }
  const downloadMatch = path.match(/^\/download\/([^/]+)$/);
  if (downloadMatch && request.method === "GET") {
    return selectDownload(env, config, downloadMatch[1]);
  }

  // ---- 管理 API（/admin/*）----
  if (path.startsWith("/admin/") || path === "/admin") {
    return routeAdmin(request, env, config, path, url);
  }

  // 原版支持但 CF 迁移版不提供的功能
  if (path.startsWith("/chunk") || path.startsWith("/presign")) {
    return errorResponse(404, "分片/预签名上传在 Cloudflare 迁移版不可用");
  }

  return errorResponse(404, "资源不存在");
}

/** 上传权限守卫：open_upload=0 时需要管理员 Bearer token */
async function guardUpload(config: SiteConfig, request: Request): Promise<void> {
  if (Number(config.open_upload ?? 1) === 1) return;
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new ShareError(403, "本站未开启游客上传，如需上传请先登录后台");
  }
  await requireAdmin(String(config.jwt_secret || ""), authorization);
}

async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return jsonResponse(200, {
      code: 200,
      message: "ok",
      detail: {
        initialized: false,
        hint: "请 POST 到 /setup 完成初始化，body: { admin_password, confirm_password, site_name? }",
      },
    });
  }
  const body = (await request.json().catch(() => ({}))) as {
    admin_password?: string;
    confirm_password?: string;
    site_name?: string;
  };
  if (body.admin_password !== body.confirm_password) {
    return jsonResponse(400, { code: 400, message: "两次输入的管理员密码不一致", detail: "两次输入的管理员密码不一致" });
  }
  try {
    await initializeSystem(env, String(body.admin_password || ""), body.site_name);
  } catch (e) {
    if (e instanceof ShareError) {
      return jsonResponse(e.status, { code: e.status, message: e.message, detail: e.message });
    }
    throw e;
  }
  return okResponse({ ok: true, admin: "/#/admin" });
}

async function routeAdmin(
  request: Request,
  env: Env,
  config: Awaited<ReturnType<typeof loadConfig>>,
  path: string,
  url: URL
): Promise<Response> {
  // 登录无需鉴权
  if (path === "/admin/login" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    return login(env, config, body);
  }

  const authorization = request.headers.get("Authorization");
  // 其余管理端点统一鉴权（401）
  await requireAdmin(String(config.jwt_secret), authorization);

  if (path === "/admin/verify" && request.method === "GET") {
    return verify(env, config, authorization);
  }
  if (path === "/admin/logout" && (request.method === "POST" || request.method === "GET")) {
    return okResponse({ ok: true });
  }
  if (path === "/admin/dashboard" && request.method === "GET") {
    return dashboard(env, config);
  }
  if (path === "/admin/activities" && request.method === "GET") {
    return okResponse({ activities: [] });
  }
  if (path === "/admin/config/get" && request.method === "GET") {
    return adminConfigGet(env);
  }
  if (path === "/admin/config/update" && request.method === "PATCH") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return adminConfigUpdate(env, body);
  }
  if (path === "/admin/file/list" && request.method === "GET") {
    return fileList(env, url.searchParams);
  }
  if (path === "/admin/file/detail" && (request.method === "GET" || request.method === "POST")) {
    const id = request.method === "GET" ? Number(url.searchParams.get("id") || 0) : Number(((await request.json().catch(() => ({}))) as { id?: number }).id || 0);
    if (!id) return errorResponse(400, "缺少 id");
    return fileDetail(env, id);
  }
  if (path === "/admin/file/delete" && request.method === "DELETE") {
    const body = (await request.json().catch(() => ({}))) as { id?: number };
    if (!body.id) return errorResponse(400, "缺少 id");
    return deleteFile(env, body.id);
  }
  if (path === "/admin/file/batch-delete" && (request.method === "DELETE" || request.method === "POST")) {
    const body = (await request.json().catch(() => ({}))) as { ids?: number[] };
    return batchDelete(env, body.ids || []);
  }
  if (path === "/admin/file/download" && request.method === "GET") {
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return errorResponse(400, "缺少 id");
    return adminDownload(env, id);
  }
  if (path === "/admin/file/preview" && request.method === "GET") {
    const id = Number(url.searchParams.get("id") || 0);
    const maxChars = Number(url.searchParams.get("max_chars") || 4000) || 4000;
    if (!id) return errorResponse(400, "缺少 id");
    return adminPreview(env, id, maxChars);
  }
  if (path === "/admin/file/view-presets" && request.method === "GET") {
    return viewPresetsGet(env);
  }
  if (path === "/admin/file/view-presets" && (request.method === "POST" || request.method === "PATCH")) {
    const body = (await request.json().catch(() => ({}))) as { id?: string; name?: string; filters?: unknown };
    return viewPresetsSave(env, body);
  }
  if (path === "/admin/file/view-presets" && request.method === "DELETE") {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return errorResponse(400, "缺少 id");
    return viewPresetsDelete(env, body.id);
  }
  if (path === "/admin/file/view-presets/delete" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return errorResponse(400, "缺少 id");
    return viewPresetsDelete(env, body.id);
  }
  if (path === "/admin/local/lists" && request.method === "GET") {
    return okResponse([]);
  }
  if (path === "/admin/local/delete" && request.method === "DELETE") {
    return okResponse(false);
  }
  if (path === "/admin/local/share" && request.method === "POST") {
    return errorResponse(400, "本地文件分享在 Cloudflare 迁移版不可用");
  }

  // 高级功能：CF 迁移版不提供
  if (
    path.includes("policy-action") ||
    path.includes("batch-update") ||
    path === "/admin/file/update" ||
    path === "/admin/file/metadata"
  ) {
    return errorResponse(400, "该功能在 Cloudflare 迁移版不可用");
  }

  return errorResponse(404, "资源不存在");
}
