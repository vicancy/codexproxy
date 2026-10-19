# Codex WSL Proxy (systemd 常驻版)

这个项目在 WSL 中提供一个本地代理，可在 Azure OpenAI 和 GitHub Copilot 间切换：
- 对外提供 OpenAI 兼容路径：`http://127.0.0.1:17777/openai/v1`
- Azure 模式使用 `DefaultAzureCredential`（Entra ID），不依赖 API Key
- GitHub Copilot 模式通过非官方 `copilot-proxy-api` 本机 bridge 转发，需要单独登录和配置；详见 4.2

## 1. 前提条件

- WSL 已启用 `systemd`
- 已安装 Node.js（当前机器使用 nvm）
- 你已经完成 Azure 登录（你目前已 `az login`）
- Codex 配置指向代理：`/root/.codex/config.toml`

## 2. 一次性安装 systemd 服务

在项目根目录执行：

```bash
cd ~/codexproxy
chmod +x scripts/install-systemd-service.sh
sudo ./scripts/install-systemd-service.sh
```

安装脚本会做这些事：
1. 按当前项目路径和项目 owner 生成 service 文件到 `/etc/systemd/system/codexproxy.service`
2. 生成（或更新）环境变量文件 `/etc/default/codexproxy`
3. 执行 `systemctl daemon-reload`
4. 执行 `systemctl enable codexproxy.service`
5. 执行 `systemctl restart codexproxy.service`

## 3. 日常运维命令

查看服务状态：

```bash
systemctl status codexproxy.service --no-pager
```

重启服务：

```bash
sudo systemctl restart codexproxy.service
```

停止服务：

```bash
sudo systemctl stop codexproxy.service
```

启动服务：

```bash
sudo systemctl start codexproxy.service
```

开机自启开关：

```bash
sudo systemctl enable codexproxy.service
sudo systemctl disable codexproxy.service
```

## 4. 如何改 Azure Endpoint

编辑环境文件：

```bash
sudo editor /etc/default/codexproxy
```

重点变量：

- `UPSTREAM_AOAI_BASE_URL`：改成新的 Azure OpenAI endpoint（必须带 `/openai/v1`）
- `AZURE_OPENAI_SCOPE`：默认保持 `https://cognitiveservices.azure.com/.default`
- `LISTEN_HOST` / `LISTEN_PORT`：本地监听地址和端口

示例：

```env
UPSTREAM_AOAI_BASE_URL=https://<your-new-resource>.openai.azure.com/openai/v1
```

修改后生效步骤：

```bash
sudo systemctl daemon-reload
sudo systemctl restart codexproxy.service
```

然后验证：

```bash
curl -sS http://127.0.0.1:17777/healthz
curl -sS -w '\nHTTP_STATUS=%{http_code}\n' http://127.0.0.1:17777/readyz
```

### 4.1 调整上游超时

当前机器在 `/etc/default/codexproxy` 中使用以下覆盖值，单位为**毫秒**：

```ini
UPSTREAM_HEADERS_TIMEOUT_MS=300000
UPSTREAM_BODY_TIMEOUT_MS=600000
```

- 响应头超时：300 秒，避免较慢的模型首响应被原来的 30 秒限制提前中断。
- 响应体超时：保持 600 秒，是接收响应体数据时的空闲超时，不是整个生成过程的总时限。
- 不建议直接设为 3000 秒：单次等待可能长达 50 分钟，客户端重试会进一步延长故障反馈时间。客户端自身也可能更早超时。
- 这是当前机器的配置覆盖；源码默认值和部署模板的响应头超时仍为 30 秒。新机器需按需配置。

在 WSL 中修改并生效：

```bash
sudo editor /etc/default/codexproxy
# 修改已有的 UPSTREAM_HEADERS_TIMEOUT_MS 行，不要重复添加。
sudo systemctl restart codexproxy.service
systemctl status codexproxy.service --no-pager
curl --fail-with-body -sS --max-time 10 http://127.0.0.1:17777/healthz
curl --fail-with-body -sS --max-time 45 http://127.0.0.1:17777/readyz
```

只修改环境文件时无需 `daemon-reload`，但必须重启进程；重启会中断正在进行的请求。修改 unit 文件时才需要先执行 `sudo systemctl daemon-reload`。

在 Windows PowerShell 中也可重启：

```powershell
wsl -d Ubuntu -u root -- systemctl restart codexproxy.service
```

查看**运行进程实际加载的值**，而不仅是磁盘上的配置：

```bash
pid=$(systemctl show codexproxy.service -p MainPID --value)
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -E '^UPSTREAM_(HEADERS|BODY)_TIMEOUT_MS='
```

### 4.2 切换到 GitHub Copilot

codexproxy 可通过社区项目 `copilot-proxy-api` 转发到 GitHub Copilot。它是**非官方桥接**，GitHub 不保证兼容性；Copilot 账户有独立的模型权限、用量和速率限制，切换不保证不再遇到 rate limit。

先用运行 codexproxy 的同一个 Linux 用户完成一次 GitHub 登录（当前为 `vicancy`），避免 token 存到 root 的 home：

```bash
sudo -iu vicancy
npm exec --yes --registry=https://packagefeedproxy.microsoft.io/npm/ \
  --package=copilot-proxy-api@0.10.32 -- copilot-proxy-api auth
```

登录 token 会保存在该用户的 `~/.local/share/copilot-proxy-api/` 下。不要使用 `--show-token`，也不要公开这个目录或 bridge 端口。

生成一个仅供本机 bridge 使用的 API key：

```bash
openssl rand -hex 32
```

把生成的值填入 `/etc/default/codexproxy`，并保持该文件仅 root 可读：

```ini
UPSTREAM_PROVIDER=azure
COPILOT_PROXY_BASE_URL=http://127.0.0.1:4141/v1
COPILOT_PROXY_API_KEY=<上一步生成的值>
```

重新生成两个 systemd unit，然后启动 Copilot bridge。安装脚本会将含 key 的环境文件权限收紧为 `0600`；`copilot-proxy-api.service` 会以项目 owner 运行，并固定使用已审查的 `0.10.32` 版本：

```bash
cd ~/codexproxy
sudo bash scripts/install-systemd-service.sh
sudo systemctl enable --now copilot-proxy-api.service
```

在 Azure 与 Copilot 间切换时，只改 `UPSTREAM_PROVIDER`，保留 Codex 的 base URL `http://127.0.0.1:17777/openai/v1`：

```ini
UPSTREAM_PROVIDER=github-copilot
```

应用切换并验证 bridge：

```bash
sudo systemctl restart codexproxy.service
curl -sS http://127.0.0.1:17777/readyz
curl -sS http://127.0.0.1:17777/openai/v1/models
```

切回 Azure：将 `UPSTREAM_PROVIDER=azure` 后重启 `codexproxy.service`。Azure 的 endpoint 和 Entra 登录配置会保留。不要直接把两个服务都设为对外监听；Copilot bridge 使用 API key，建议仅在本机使用。

## 5. 怎么看错误日志（重点）

看最近 200 行：

```bash
journalctl -u codexproxy.service -n 200 --no-pager
```

实时跟踪：

```bash
journalctl -u codexproxy.service -f
```

只看 error 级别（systemd priority）：

```bash
journalctl -u codexproxy.service -p err --since today --no-pager
```

按时间窗口查：

```bash
journalctl -u codexproxy.service --since "10 min ago" --no-pager
```

只看本次启动后的日志（避免被历史报错干扰）：

```bash
journalctl -u codexproxy.service --since "5 min ago" --no-pager
```

## 6. 常见问题

### Q1: `status` 里提示找不到 Node

原因：`NODE_BIN` 指向旧版本 nvm 路径。

处理：

```bash
command -v node
sudo editor /etc/default/codexproxy
# 更新 NODE_BIN 为 command -v node 输出
sudo systemctl restart codexproxy.service
```

### Q2: `/readyz` 返回 503，`credential_unavailable`

原因：`DefaultAzureCredential` 当前无法在 WSL 中拿到 token。

处理：
1. 在 WSL 内确认 Azure 登录状态：`az account show`
2. 确认服务能找到 Azure CLI：`systemctl cat codexproxy.service --no-pager | rg 'User=|HOME=|PATH='`
3. 必要时重新登录：`az login`
4. 重新安装并重启服务：`sudo ./scripts/install-systemd-service.sh`
5. 再看日志定位：`journalctl -u codexproxy.service -n 200 --no-pager`

### Q3: 想恢复默认配置模板

模板文件在项目内：
- `deploy/codexproxy.service`
- `deploy/codexproxy.env.example`

重新安装：

```bash
cd ~/codexproxy
sudo ./scripts/install-systemd-service.sh
```

### Q4: 日志里出现 `EADDRINUSE: 127.0.0.1:17777`

原因：端口已被其他进程占用（常见是之前手动 `node src/index.js` 没停）。

处理：

```bash
ss -ltnp | rg 17777
sudo pkill -f "node src/index.js"  # 只在确认是旧手动进程时执行
sudo systemctl restart codexproxy.service
```

### Q5: `502 Headers Timeout Error` 是代理还是 Azure 返回的？

2026-09-21 的排查确认，这次请求经过
`127.0.0.1:17777/openai/v1` 转发到 `pmagent2.openai.azure.com`。
代理进程当时实际加载的响应头超时为 `30000` 毫秒，客户端失败调用耗时约 33.6–34.4 秒。
当天 14:20–14:32（AEST，UTC+10）的代理日志中，有 14 条 `Headers Timeout Error`，同时有 14 条上游 HTTP 200 完成记录。
这些是该代理所有请求的统计，不能全部归到某一个会话。

关键日志：

```json
{"level":"error","message":"Proxy request failed","method":"POST","path":"/openai/v1/responses","error":"Headers Timeout Error"}
```

`src/proxy.js` 将 Undici 等待响应头超时产生的异常转换成 HTTP 502，
响应体为 `{"error":"proxy_error","message":"Headers Timeout Error"}`。
因此这类 **502 是本地代理生成的，不是已确认 Azure 返回的 HTTP 502**。
Azure 慢响应或代理到 Azure 的网络延迟仍可能是触发因素；现有日志没有足够的请求关联信息来进一步归因。

处理：按 4.1 将响应头超时增至 300 秒，保持响应体超时 600 秒。
之后观察真实模型请求是否仍超时。健康检查或模型列表返回 200 只说明代理和对应请求可用，不证明长上下文推理的超时问题已消失。

### Q6: 重启后出现 `status=200/CHDIR`，服务不断重启

2026-09-21 遇到的启动失败：

```text
Changing to the requested working directory failed: No such file or directory
Control process exited, code=exited, status=200/CHDIR
```

当时已安装的 unit 使用 `User=root`、`WorkingDirectory=/root/codexproxy`，
启动命令和 `NODE_BIN` 也指向 `/root`，但程序实际在 `/home/vicancy/codexproxy`，
Node 位于 `/home/vicancy/.nvm/versions/node/v24.15.0/bin/node`。
这是本地服务配置问题，发生在连接 Azure 之前，与 Q5 的上游响应头超时是两件事。

先停止重启循环并核对配置：

```bash
sudo systemctl stop codexproxy.service
systemctl show codexproxy.service -p User -p WorkingDirectory -p ExecStart -p EnvironmentFiles
grep '^NODE_BIN=' /etc/default/codexproxy
```

从实际项目目录运行现有安装脚本，按目录 owner 和实际路径重新生成 unit：

```bash
cd /home/vicancy/codexproxy
sudo bash scripts/install-systemd-service.sh
```

安装脚本会刷新 `NODE_BIN`，保留已有环境文件中的其他设置（包括超时覆盖），并加载、启用和重启服务。
不要只改 `WorkingDirectory`，还需保证 `User`、`HOME`、`ExecStart`、Node 路径和 Azure CLI 可用性一致。

如果 Windows 侧执行 `sudo -n` 提示需要密码，可使用 WSL 的 root 用户执行同一安装脚本：

```powershell
wsl -d Ubuntu -u root -- bash /home/vicancy/codexproxy/scripts/install-systemd-service.sh
```

本次修复后服务以 `vicancy` 运行，`/healthz` 和 `/readyz` 成功，
通过代理访问 Azure 的 `/openai/v1/models` 返回 HTTP 200。

## 7. 关键文件

- Service 模板：`~/codexproxy/deploy/codexproxy.service`
- 环境变量示例：`~/codexproxy/deploy/codexproxy.env.example`
- 安装脚本：`~/codexproxy/scripts/install-systemd-service.sh`
- 实际生效的环境变量：`/etc/default/codexproxy`
- systemd unit：`/etc/systemd/system/codexproxy.service`


## 8. 每次请求的 token 与限流诊断

代理会输出结构化 JSON 到 systemd journal：`request.started`、`response.headers`、`request.completed` 通过同一个 `request_id` 关联，并标记当前 `provider`（`azure` 或 `github-copilot`）。时间戳为 UTC。

- 请求：部署/模型、是否流式、请求与实际转发的 reasoning effort、明确设置的输出 token 上限、输入条目数、工具数、原始/转发字节数。未指定的输出上限显示 `null`，代理不猜测模型默认值。
- 响应：HTTP 状态、上游 request ID、响应头耗时、首个响应体字节耗时、总耗时、响应字节数、Responses 最终状态。
- 实际 usage：输入、缓存输入、缓存写入、未命中缓存输入、输出、推理输出、服务端报告的总 token。缓存/推理都是子集，不再次叠加进 total。
- 限流：只收集存在的 `x-ratelimit-*` 白名单字段和 `retry-after` / `retry-after-ms`；缺失表示上游没提供，不能解释成无限额度。
- 错误：同时识别 HTTP 429 和 HTTP 200 中的流式 `response.failed` / `error`。记录错误 code/type，并将限流分类为 tokens、requests、provisioned_throughput 或 unspecified；不保存原始错误 message（其中可能回显输入）。
- 中断或客户端断开且没有收到 usage 的响应使用 `usage_available: false` 与 `usage: null`，不记录为零。若已收到模型终止事件，客户端随后关闭连接保留模型的实际结果，并单独标记 `client_disconnected`，避免将已完成请求误报为失败。Chat Completions 只有上游确实返回 usage 才能统计；代理不会擅自加入 `stream_options.include_usage`。

日志不保存请求/响应正文、提示词、代码、工具参数或认证头。JSON/SSE 只在内存中短暂解析；旁路观察器的 JSON/单个 SSE 事件限制为 4 MiB，超过时标记 `size_limit`，不截断实际转发。已有 Sticky High 路径复用其已经解析的请求对象。压缩响应照常转发，观察标记为 `encoded_body`，不伪造 usage。

查看最近 15 分钟（最近 30 条完成请求 + 按完成分钟/模型汇总）：

```bash
cd ~/codexproxy
npm run usage
npm run usage -- --since "1 hour ago"
```

实时查看每次请求：

```bash
npm run usage -- --follow
```

查看完整白名单 JSON（包含实际限流响应头）：

```bash
npm run usage -- --since "30 minutes ago" --json
# 或查看所有请求开始、响应头、完成事件：
journalctl -u codexproxy.service -f -o cat
```

汇总时间按请求**完成时间**归组，仅统计服务端报告的 usage。`?` 表示未知，`missing_usage` 表示未收到 usage 的请求数。这不是 Azure 在请求进入时的 TPM 估算，也不是账单；不能用它直接倒算当时剩余配额。历史旧日志没有 usage，无法补回。

实现核对依据：[Responses 流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Azure 限流与响应头](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota#rate-limit-response-headers)。
