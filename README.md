# FileCodeBox Cloudflare 迁移版（filecodebox-cf）

把 [vastsa/FileCodeBox](https://github.com/vastsa/FileCodeBox)（Python FastAPI + SQLite + 本地磁盘）迁移到 **Cloudflare Workers + D1 + R2**，免云服务器、免 Docker、免运维，前端零修改。

## 开源许可证

本项目是 [vastsa/FileCodeBox](https://github.com/vastsa/FileCodeBox) 的衍生作品，遵循原项目 **LGPL-3.0** 许可证（见根目录 `LICENSE`）。依据 LGPL-3.0 要求：保留原版权声明与许可证全文，并注明本项目的修改内容。

- 原作者与版权：Lan（xzu@live.com），FileCodeBox 项目
- 本项目修改：将 Python FastAPI 后端重写为 Cloudflare Workers（TypeScript），SQLite 迁移至 D1，本地磁盘存储迁移至 R2；裁剪分片上传、预签名上传、本地文件管理等依赖常驻进程/本地磁盘的功能

## 架构

```
浏览器 (Vue SPA, hash 路由)
   │  同一域名，同域 API，无 CORS 问题
   ▼
Cloudflare Worker (src/index.ts)
   ├── 静态资源托管  -> assets/ (前端 dist 构建产物)
   ├── /share/*      -> 分享 API（文本/文件上传、取件、下载）
   ├── /admin/*      -> 管理后台（登录、仪表盘、文件管理、配置）
   ├── /api/v1/config、/、/health、/setup
   └── Cron 每日清理 -> D1 查过期记录 + R2 删文件
   │
   ├── D1 (FILEBOX_DB)     存分享记录 file_codes + 站点配置 key_value
   └── R2 (FILEBOX_FILES)  存上传文件本体
```

## 目录结构

```
filecodebox-cf/
├── wrangler.toml          # CF 配置：D1 / R2 / Cron / Assets
├── package.json           # wrangler 脚本（dev / deploy / db:init）
├── tsconfig.json
├── migrations/
│   └── 0001_init.sql      # D1 建表
├── assets/                # 前端静态资源（构建产物，已就绪）
└── src/
    ├── index.ts           # 入口：路由 + CORS + 未初始化守卫 + cron
    ├── util.ts            # 时间(UTC+8)、口令、文件名、SHA256、JWT 工具
    ├── config.ts          # 站点配置（D1 存取、初始化、公共配置）
    ├── auth.ts            # JWT 签发/验证、管理员鉴权
    ├── share.ts           # 分享核心：上传/取件/下载/过期清理
    ├── admin.ts           # 管理后台
    └── respond.ts         # 统一响应格式
```

## 部署步骤

前置：已安装 Node.js 18+ 与 Cloudflare 账号（免费套餐即可）。

```bash
cd filecodebox-cf
npm install

# 1. 创建 D1 数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create filecodebox

# 2. 创建 R2 存储桶
npx wrangler r2 bucket create filecodebox-files

# 3. 本地预览（可选）
npx wrangler dev --local

# 4. 执行数据库迁移（远端）
npx wrangler d1 execute filecodebox --remote --file=./migrations/0001_init.sql

# 5. 部署
npx wrangler deploy
```

部署完成后：

1. 浏览器打开 `https://filecodebox-cf.<你的子域>.workers.dev`
2. 首次访问显示"系统未初始化"，调用初始化接口设置管理员密码：

```bash
curl -X POST https://filecodebox-cf.<你的子域>.workers.dev/setup \
  -H 'Content-Type: application/json' \
  -d '{"admin_password":"你的密码(至少8位)","confirm_password":"你的密码","site_name":"我的文件柜"}'
```

3. 回到站点首页即可上传/分享；后台地址 `/#/admin`，用刚设置的密码登录。

## 已验证功能（本地 wrangler dev 冒烟测试全通过）

| 功能 | 接口 | 状态 |
|---|---|---|
| 系统初始化 | POST /setup | ✅ |
| 公共配置 | POST /、GET /api/v1/config | ✅ |
| 文本分享 | POST /share/text/ | ✅ |
| 文件上传（multipart） | POST /share/file/ | ✅ |
| 取件（JSON 详情/下载地址） | POST /share/select/ | ✅ |
| 直接下载 | GET /share/select?code= | ✅ |
| 元数据 | POST /share/metadata/ | ✅ |
| token 鉴权下载 | GET /share/download?key=&code= | ✅（错误 key 403） |
| 次数型分享扣减 | count 模式 2→1→0，耗尽自动过期 | ✅ |
| 管理员登录/验证 | POST /admin/login、GET /admin/verify | ✅ |
| 仪表盘/文件列表/详情/删除/下载 | /admin/dashboard、/admin/file/* | ✅ |
| 未初始化守卫 428 | 非 /setup 请求 | ✅ |
| 未授权 401 | 管理接口无 token | ✅ |
| Cron 过期清理 | D1 删记录 + R2 删文件 | ✅ |
| 前端静态资源同域托管 | /、/assets/* | ✅ |

## 与原版的差异（有意裁剪）

| 原版功能 | CF 迁移版 | 原因 |
|---|---|---|
| 分片上传（/chunk/*） | ❌ 404 | Workers 无多副本合并语义；默认未开启 |
| 预签名上传（/presign/*） | ❌ 404 | 同上 |
| 本地文件管理（/admin/local/*） | ❌ 返回空/不支持 | CF 无本地磁盘 |
| 文件健康洞察/活动记录/策略动作 | ❌ 返回空 | 依赖进程内规则引擎，迁移成本高 |
| scrypt 密码哈希 | ✅ PBKDF2-SHA256 | WebCrypto 原生支持，格式 `pbkdf2$iter$salt$hash` |
| SQLite（Tortoise ORM） | ✅ D1 | 表结构对齐 |
| 本地磁盘存储 | ✅ R2 | 键路径 `share/data/YYYY/MM/DD/uuid/文件名` 对齐 |
| 进程内 IP 限流 | ❌ 移除 | Worker 无进程内状态，需 Cloudflare Rate Limiting 另行配置 |

## 限制与注意事项

1. **上传大小**：Workers 免费套餐请求体上限 **100MB**（付费 200MB）。站点默认配置 `upload_size=10MB`，可在后台调大，但受平台上限约束。
2. **定时清理频率**：Workers Cron 最低 1 分钟，本项目设每天 03:00（UTC）触发一次。原版每 10 分钟清理，实际影响很小（过期判断在取件时也会实时拦截）。
3. **无直链下载**：原版 S3 模式会给预签名直链；R2 绑定对象默认不开放公网直链，本项目统一走 Worker 代理下载（`/share/download`），行为与原版"本地/次数型"路径一致，下载会经过 Worker 流量（免费套餐含 10 万请求/日）。
4. **密钥安全**：`admin_token`（密码哈希）与 `jwt_secret` 存在 D1 的 key_value 表中，属于站点配置；管理后台读取配置时已隐藏这两项原文。
5. **并发模型**：Workers 为请求触发、无长时间后台进程，原版依赖常驻进程的定时任务已由 Cron Trigger 替代。

## 前端说明

- 前端仓库 `FileCodeBoxFronted` 生产环境 `VITE_API_BASE_URL_PROD` 为空 → **同域调用 API，前端零修改**。
- `assets/` 已放入构建产物；如需重新构建：

```bash
git clone https://github.com/vastsa/FileCodeBoxFronted.git
cd FileCodeBoxFronted
# pnpm 11 需要在 pnpm-workspace.yaml 放行 esbuild: allowBuilds: { esbuild: true }
pnpm install --no-frozen-lockfile
pnpm run build-only
cp -r dist/* ../filecodebox-cf/assets/
```

## 本地开发

```bash
npx wrangler dev --local            # 本地起服务 http://localhost:8787
npx wrangler d1 execute filecodebox --local --file=./migrations/0001_init.sql   # 初始化本地 D1
```
