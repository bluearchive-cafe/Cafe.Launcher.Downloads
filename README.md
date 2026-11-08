# Cafe.Launcher.Downloads

独立的 Cafe Launcher 下载 Worker，部署名为 `cafe-launcher-downloads`。GitHub Release 仍是发布来源；无需修改启动器仓库的 `release.ps1` 或 GitHub Actions。

## 运行方式

- Worker：`cafe-launcher-downloads`，对外域名 `https://download.cafe-launcher.saibamidori.com`，同时保留 `https://cafe-launcher-downloads.gytxtx.workers.dev`。
- 私有 R2：`cafe-launcher-releases`，绑定名 `RELEASES`。`r2.dev` 与桶的公开自定义域名均关闭，对外只经 Worker 域名访问。
- 固定源仓库：`bluearchive-cafe/Cafe.Launcher.Avalonia`，不接受任意回源 URL。
- 每 10 分钟检查 GitHub 列表前 20 项中的最近 3 个有效、非草稿 release（包含预发布）。不是全部历史版本扫描；已镜像的旧版本继续保留，不自动删除。
- 每轮最多复制 2 个非清单资产，优先 Windows 安装器、Windows ZIP；清单和元数据不占该额度。新版本有 8 个包时通常需 4 轮，约 30–40 分钟才齐备。可用管理脚本提前同步。
- 单资产最多 512 MiB，清单最多 64 KiB；支持当前及旧 `Cafe.Launcher.Avalonia_` 前缀，以及 Homebrew Cask。
- 只同步 uploaded 资产。SHA256SUMS 必须覆盖全部资产且每个条目均存在，防止抓取正在上传中的 release。GitHub digest 如存在，必须与清单相符。
- 通过 R2 `put({sha256})` 校验流式上传，全部文件通过后才生成该版本的就绪元数据。未就绪文件不对外提供。
- 同步失败下轮重试，条件写入租约防止同步任务重叠；单文件回源超时 120 秒，任务在预算用完后停止开始新传输。R2 文件元数据包含 SHA-256；直接使用 GitHub API 时同时记录源资产 ID。
- 已镜像版本视为不可变快照。发现同 tag 的资产被替换时报告冲突，不覆盖旧文件；需要维护者核实后另发版本。源版本被撤回后，已有镜像不会自动删除。
- GitHub API 未配置令牌时使用公开访问；网络失败或非成功响应时，自动回退到产品现有的 `/api/v2/launcher/releases` 元数据代理，文件和清单仍从 GitHub 下载。代理不提供 GitHub 资产 ID 时以大小和 SHA-256 绑定内容，不向代理发送 GitHub 凭据。也可运行 `npx wrangler secret put GITHUB_TOKEN`，仅需读取公开仓库。令牌仅发送至 GitHub API，不发送到资产重定向地址。

## HTTP 接口

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/health` | GET / HEAD | 进程健康检查，不表示版本已同步 |
| `/`、`/releases` | GET / HEAD | 仅列出完成校验的镜像版本，下载 URL 为相对路径 |
| `/downloads/<tag>/<asset-name>` | GET / HEAD | 下载就绪文件，支持单段 Range、ETag、If-Range、条件请求 |
| `/admin/status` | GET / HEAD | 查看最后一次同步状态，需要管理员 Bearer 令牌 |
| `/admin/stats` | GET / HEAD | 查询近 30 个 UTC 自然日的聚合统计，需要管理员 Bearer 令牌 |
| `/admin/sync` | POST | 等待一轮有界同步完成，需要管理员 Bearer 令牌 |

例：`/downloads/v1.3.1/Cafe.Launcher_v1.3.1_setup.exe`。尚未就绪的版本返回 404，不临时代理未校验文件；可以使用原始 GitHub Release 下载。

查询参数一律拒绝，不通过 URL 携带令牌。未提供上传、删除、列表桶内部文件的接口。

## 访问控制和缓存

默认面向公开发行包，匿名可读。只允许 GET/HEAD、合法 SemVer tag、固定资产名和已完成的版本元数据。每个客户端 IP 每分钟约 120 次请求，命中缓存同样检查限流；这是每个 Cloudflare 节点的近似防滥用限制，不是全球精确配额，共享出口用户共用额度。IP 只参与限流，不写入自定义日志和统计。

如需要私有下载，设置独立的 `DOWNLOAD_TOKEN` secret。之后所有公开路由也必须提交 `Authorization: Bearer ...`，响应为 `private, no-store`。管理接口始终使用另一枚 `ADMIN_TOKEN`，不接受下载令牌。公开客户端不应内置长期密钥。

文件使用带 SHA-256 的稳定 ETag 和版本路径。完整 GET 使用 Cloudflare Cache API，缓存键包括摘要；Range 直接从 R2 读取，不把 206 写缓存。Cache API 是节点本地缓存，不能保证文件始终在边缘。私有下载模式不新增缓存，读取既有缓存前仍检查鉴权和限流。

## 请求日志和流量统计

Workers Observability 中启用结构化日志，head sampling 为 1，关闭自动 invocation logs；显式日志不记录 IP、Authorization、查询字符串、User-Agent 或 GitHub 临时签名 URL。Cloudflare 自身仍按其平台政策处理请求和运行日志。

- `download_request`：route / method / tag / file / status / source / responseBytes / durationMs。
- `sync_asset`：已校验复制的 tag / file / bytes / sha256。
- `sync_complete`：一轮同步的上传量、就绪/等待版本和错误。

统计保存到独立 D1 数据库 `cafe-launcher-downloads-stats`（绑定 `STATS`），按 UTC 日期、路由、版本、文件、方法、来源和状态码聚合。每个请求以原子 UPSERT 增加请求数、声明响应字节和响应头处理耗时总和；不保存逐用户记录。

`GET /admin/stats` 返回近 30 个 UTC 自然日的总量和最多 500 条分类记录，必须携带 ADMIN_TOKEN。本机运行 `pwsh ./scripts/Get-MirrorStatistics.ps1` 可直接查询，无需复制令牌；加 `-SummaryOnly` 只看汇总。更多查询见 `queries/traffic.sql`：

```powershell
npx wrangler d1 execute cafe-launcher-downloads-stats --remote --command "SELECT tag, file, SUM(requests) AS requests, SUM(response_bytes) AS declared_bytes FROM traffic_daily WHERE route = 'download' GROUP BY tag, file;"
```

下载 GET 200/206 的 Content-Length 计入声明响应字节；HEAD、304、错误为 0。请求数不是完整下载次数，声明响应大小不是确认送达客户端的字节数，耗时不包括整个文件传输。统计写入在短时 waitUntil 中完成，异常会记录 `statistics_write_failed`，不使下载失败；配额耗尽、请求终止等情形可能漏计。日志和统计不能作为精确计费或完整安全审计账本。D1 按日汇总目前不自动删除，日志保留时间由 Cloudflare 账户计划决定。

## 本地开发与部署

```powershell
npm ci
npm run cf-typegen
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply cafe-launcher-downloads-stats --remote
npm run deploy
```

测试在 workerd 中运行，R2/缓存使用本地隔离存储，网络回源由测试替身响应，不接触生产桶。

`ADMIN_TOKEN` 是 Wrangler secret。部署时生成的本地副本保存在 `.secrets/admin-token`（已忽略，不要提交或发送到聊天）。手动同步：

```powershell
pwsh ./scripts/Invoke-MirrorSync.ps1 -Batches 4
```

该脚本保持请求连接直到每批完成；不要改成 HTTP 响应后仅由 `waitUntil()` 继续下载大文件。首次同步通常需要多批，可查看 `/admin/status`；Cron 会自动接续。Cron 配置部署后可能需要数分钟传播。

服务与 R2 位于独立项目；本次不修改启动器的更新检查、下载器或发布流程。启动器仍使用原 GitHub 地址，接入本镜像需要另行修改下载器。网站和浏览器可直接使用这里的镜像地址。




