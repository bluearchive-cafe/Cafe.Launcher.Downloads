# Cafe.Launcher.Downloads

Cafe Launcher 的 Cloudflare Worker 下载镜像与 OpenAPI 服务，部署名 `cafe-launcher-downloads`，生产域名 `https://download.cafe-launcher.saibamidori.com`。

Worker 从 GitHub Releases 同步最近若干版本的资产到 R2，只在 `SHA256SUMS` 校验通过后对外提供不可变下载，并用 D1 记录按文件与按日的请求统计。接口由 [chanfana](https://github.com/cloudflare/chanfana) 与 [Hono](https://github.com/honojs/hono) 注册，OpenAPI 3.1 文档位于 `/docs`，原始 schema 位于 `/openapi.json`。

> 独立的 `Cafe.Launcher.OpenAPI` 仓库已删除。OpenAPI 迁移在本仓库就地完成，Worker 名称与自定义域名保持不变。

## 接口

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/v1/health` | GET / HEAD | 进程健康检查，不表示版本已同步 |
| `/v1/releases` | GET / HEAD | 仅列出完成校验的镜像版本，下载 URL 为 `/v1/downloads/...` 相对路径 |
| `/v1/downloads/<tag>/<asset-name>` | GET / HEAD | 下载就绪文件，支持单段 Range、ETag、If-Range 与条件请求 |
| `/v1/admin` | GET / HEAD | 管理面板页面，只含界面不含凭据 |
| `/v1/admin/status` | GET / HEAD | 查看最后一次同步状态，需要管理员 Bearer 令牌 |
| `/v1/admin/stats` | GET / HEAD | 查询近 30 个 UTC 自然日的聚合统计，需要管理员 Bearer 令牌 |
| `/v1/admin/sync` | POST | 等待一轮有界同步完成，需要管理员 Bearer 令牌 |

`/v1` 是当前唯一版本前缀；去掉前缀的旧路径仅作为已部署客户端的兼容别名。根 `/` 与 `/v1` 不提供接口，均返回 404。所有接口拒绝查询参数并返回 400。除管理接口与文档端点外的公开路由，在配置 `DOWNLOAD_TOKEN` 后也会要求 Bearer 鉴权。

## 行为契约

- R2 私有桶 `cafe-launcher-releases`（绑定 `RELEASES`）保存镜像资产、版本目录与同步状态；D1 统计库 `cafe-launcher-downloads-stats`（绑定 `STATS`）保存按日的聚合计数。
- Cron 每 10 分钟同步一次：读取源仓库最近 `SYNC_RELEASE_COUNT` 个 release（默认 3），每轮最多复制 `SYNC_ASSET_LIMIT` 个资产（默认 2），单轮有时间上限。
- 资产先对照 release 的 `SHA256SUMS` 校验，清单与资产集合不一致时整版跳过；已发布的 tag 保持不可变，资产变化或大小不符需要人工处理。
- 下载路由按 IP 做近似限流（约每分钟 120 次），多段 Range 不支持；可选的 `DOWNLOAD_TOKEN` 让所有公开路由强制 Bearer 鉴权，管理接口始终使用独立的 `ADMIN_TOKEN`。
- 请求日志与统计不记录 IP、凭据、查询字符串或用户标识。GitHub 元数据接口失败或被限流时，同步回退到 `https://api.cafe-launcher.saibamidori.com/api/v2/launcher/releases`；资产地址与校验值仍按固定仓库校验。

## 本地开发

```powershell
npm ci
npm run cf-typegen
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply cafe-launcher-downloads-stats --remote
npm run dev
```

复制 `.dev.vars.example` 为 `.dev.vars` 配置本地令牌。测试在 workerd 中运行，R2 与缓存使用本地隔离存储。

## 部署

`ADMIN_TOKEN`、`DOWNLOAD_TOKEN` 与可选的 `GITHUB_TOKEN` 使用 `wrangler secret put` 配置，不写入仓库。部署到 Cloudflare 后，管理脚本 `scripts/Invoke-MirrorSync.ps1` 与 `scripts/Get-MirrorStatistics.ps1` 默认访问 `https://download.cafe-launcher.saibamidori.com`，并从 `.secrets/admin-token` 读取本地令牌副本（已忽略，不要提交）。

`wrangler.jsonc` 中的 custom domain、R2、D1、限流与 Cron 绑定随部署保持绑定。

## 源代码

本服务源代码已公开，并采用 [MIT License](./LICENSE)。桌面启动器源码位于 [bluearchive-cafe/Cafe.Launcher.Avalonia](https://github.com/bluearchive-cafe/Cafe.Launcher.Avalonia)。
