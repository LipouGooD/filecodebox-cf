// 统一响应格式（对齐原版 APIResponse）
// 成功: { code: 200, message: "ok", detail: ... }
// 失败: { code: <status>, message: <detail>, detail: <detail> }（detail 为字符串）

export function okResponse(detail: unknown): Response {
  return jsonResponse(200, { code: 200, message: "ok", detail });
}

export function errorResponse(status: number, detail: string): Response {
  return jsonResponse(status, { code: status, message: detail, detail });
}

/** 未初始化 428（前端据此跳转 /setup） */
export function setupRequiredResponse(): Response {
  return jsonResponse(428, {
    code: 428,
    message: "系统未初始化，请先完成初始化",
    msg: "系统未初始化，请先完成初始化",
    detail: { setup: "/setup" },
  });
}

export function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(headers || {}),
    },
  });
}
