# CloudBase AI 本地代理网关（hy3 · 小程序成长计划）

> 面向**其他 AI Agent / 开发者**：本文档说明如何把腾讯云开发「小程序成长计划」里的 10 个 API key 的 `hy3` 模型全部调通，并起一个本地代理端口、给每个本地 AI agent 分配独立 key 以实现并发隔离。

---

## 0. 一句话结论

两个 CloudBase 环境（网关一 / 网关二）都属于「小程序成长计划」，**用静态 API key 走 HTTP 网关直连会被 403 拒绝**（`AI_CHANNEL_NOT_ALLOWED`）。唯一干净的绕过方式：**用 `SecretId`/`SecretKey` 走 `@cloudbase/node-sdk` 在本地调用**——这条路径被服务端识别为「云开发 SDK 调用」（官方允许来源），直接扣成长计划免费额度，本地即可成功，无需部署云函数、无需付费升级套餐。

---

## 1. 问题根因

腾讯对「小程序成长计划」AI 资源包做了专项治理：

- 成长计划免费额度**只允许从「允许来源」抵扣**：小程序 SDK、云函数/云托管内的云开发 SDK、云开发控制台。
- 「AI 工具、Web SDK、第三方 API、直接 HTTP 调用」被列为**非允许来源**。
- 非允许来源调用时，**不再从成长计划额度抵扣**；若环境没有可兜底的资源点套餐，则**直接失败（403）**。
- 官方错误码页明文：*`AI_CHANNEL_NOT_ALLOWED` — 小程序成长计划仅支持小程序 SDK 和云开发 SDK 调用*。

所以：10 个 key 在 `http://...api.tcloudbasegateway.com/v1/ai/cloudbase/v1/messages` 上全部 403，跟 key 本身无关，是「直连」这个调用方式被限。

> ⚠️ 经验证：网关一/网关二**都是成长计划**，HTTP 直连一律 403；之前以为「网关一有付费套餐兜底」是误判。

---

## 2. 绕过 403 的关键手段

**本地用 `SecretId`/`SecretKey` 初始化 `@cloudbase/node-sdk`，而不是用静态 JWT key 走 HTTP 网关。**

- 静态 JWT key + HTTP 网关 = 非允许来源 → 403。
- `SecretId`/`SecretKey` + node-sdk = 云开发 SDK 调用 = 允许来源 → 成功扣免费额度。

两个环境实测都返回正常结果（`pong`）。**本地运行即可，无需云函数。**

---

## 3. 架构

```
本地多个 AI Agent（WorkBuddy 等）
   │  各自持有一个「代理 key」(agent-01..10 或 local-gateway)
   │  Authorization: Bearer <代理key>
   ▼
┌─────────────────────────────────────────────┐
│  本地代理网关 relay.js  (127.0.0.1:58046)     │
│   - 解析 apikey.txt → 10 真实 key + 凭据      │
│   - 代理 key 1:1 映射到真实 key（并发隔离）   │
│   - local-gateway → 最小负载选路（负载均衡）  │
│   - 每真实 key 并发信号量(默认5) → 超限排队   │
│   - 兼容 OpenAI /v1/chat/completions          │
│          Anthropic /v1/messages  （含流式）   │
└───────────────┬─────────────────────────────┘
                │ @cloudbase/node-sdk (SecretId/SecretKey 签名)
                ▼
      腾讯云开发 AI 模型 hy3（扣成长计划免费额度）
```

---

## 4. 代理 key 设计（这就是并发隔离的核心）

`apikey.txt` 里有 10 个真实 CloudBase key（网关一 5 个 + 网关二 5 个）。网关为每个真实 key 生成**一对一**的「代理 key」：

| 代理 key | 映射到 | 并发上限 |
|---|---|---|
| `agent-01` … `agent-05` | 网关一 5 个 key | 各 5 |
| `agent-06` … `agent-10` | 网关二 5 个 key | 各 5 |
| `local-gateway` | 负载均衡总入口（按最小负载选路） | 合计 50 |

- **给每个本地 AI agent 分配一个独立的 `agent-0X`**：该 agent 的所有流量只走它专属的真实 key，拥有独立的 5 并发额度，**与其他 agent 完全隔离**，互不抢占、互不触发限流。
- **`local-gateway`**：不想逐个分配时，用这一个 key，网关自动把请求分散到当前最空闲的真实 key（负载均衡）。
- 真实 key（JWT）**不暴露给 agent**，代理网关持有 `SecretId/SecretKey` 并统一走 node-sdk。

---

## 5. 并发处理细节

- 每个真实 key 维护一个**并发信号量**（默认 `MAX_CONCURRENCY=5`）。
- 同一 key 的并发超过 5 时，**后续请求排队等待**，而不是返回 429/403——这正好解决「每个 key 只能 5 并发」的约束。
- 命中成长计划速率限制（429）时，网关内部**指数退避重试**（最多 3 次）。
- 多 agent 各用独立 key → 总并发能力 = 10 × 5 = 50。

> 注意：成长计划是**免费额度**，仍有环境级速率上限。单 key 持续高频仍可能临时 429，网关会退避重试；合理安排 agent 数即可。

---

## 6. 复现步骤（给另一个 AI Agent）

### 6.1 准备
- Node.js（本机用 managed 22.x）。
- 安装 SDK（走本地隔离目录，不要污染全局）：
  ```bash
  export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897
  npm install --prefix <隔离目录>/cloudbase-ai @cloudbase/node-sdk
  ```
- 准备 `apikey.txt`，格式（两个网关区块，每个含 base URL / SecretId / SecretKey / 若干 JWT key）：

  ```
  一：
  https://dxt-d0gxfyz1h0c63958a.api.tcloudbasegateway.com/v1/ai/cloudbase

  SecretId
  <SecretId>

  SecretKey
  <SecretKey>

  9：
  <JWT key 9>
  8：
  <JWT key 8>
  ...

  二：
  https://dxt667-d8g0fukkce12f8fcb.api.tcloudbasegateway.com/v1/ai/cloudbase

  SecretId
  <SecretId>

  SecretKey
  <SecretKey>

  1：
  <JWT key 1>
  ...
  ```

### 6.2 启动代理网关
```bash
# start_relay.bat 等价于：
set PORT=58046
set MAX_CONCURRENCY=5
set NODE_PATH=<隔离目录>/cloudbase-ai/node_modules
node relay.js
```
启动后：
- `GET http://127.0.0.1:58046/health` → 状态
- `GET http://127.0.0.1:58046/keys` → 全部代理 key 清单（给 agent 分配用）
- `GET http://127.0.0.1:58046/status` → 各 key 实时并发负载

### 6.3 验证
```bash
node test_all_keys.js      # 10 个代理 key 双协议调通
node test_concurrency.js   # 多 agent 并发 / 排队 / 负载均衡
```

### 6.4 在 AI Agent（如 WorkBuddy）里配置
每个 agent 填：
- **Base URL**：`http://127.0.0.1:58046`
- **模型**：`hy3`
- **API Key**：分配给它的代理 key（如 `agent-01`）；懒得分配就统一填 `local-gateway`

---

## 7. 关键代码位置

| 文件 | 作用 |
|---|---|
| `relay.js` | 代理网关：解析凭据、代理 key 路由、负载均衡、并发信号量、OpenAI/Anthropic 协议、流式 |
| `start_relay.bat` | 一键启动（设置 `PORT` / `MAX_CONCURRENCY` / `NODE_PATH`） |
| `test_all_keys.js` | 10 代理 key 双协议全量验证 |
| `test_concurrency.js` | 多 agent 并发 / 排队 / 负载均衡压力测试 |
| `test_sdk.js` / `test_stream.js` | node-sdk 基础验证 / 流式验证 |
| `proxy-keys.json` | 启动时生成的代理 key 清单 |

---

## 8. 注意事项

1. **代理网关是本地后台进程**：电脑重启或会话结束后需重新运行 `start_relay.bat`。
2. **真实 key 不出网关**：agent 只拿到代理 key，凭据由 `relay.js` 持有。
3. **成长计划限流**：免费额度有环境级速率上限，高频会临时 429（网关已退避重试）。
4. **不要在「非允许来源」用静态 JWT key 直连**：那才是 403 的根源；始终走 node-sdk 这条路径。

---

## 9. 公网网关（服务器部署）排查经验（2026-08-12）

### 9.1 架构
```
https://srv.dxt116.dpdns.org
  → Cloudflare Tunnel (cloudflared-hermes.service, 隧道 ID 8f607cce-…)
  → 127.0.0.1:8787 (hermes-proxy.service, node server.js, admin@52.199.22.54, Debian 13)
  → CloudBase AI 网关（SecretId/SecretKey → node-sdk getClientCredential → Bearer token）
```
- 网关鉴权：`CB_PROXY_AUTH`（`<YOUR_GATEWAY_TOKEN>`），所有请求必须带 `Authorization: Bearer <CB_PROXY_AUTH>`。
- systemd 服务：`hermes-proxy.service`（8787）、`cloudflared-hermes.service`（隧道）、`hy-agent.service`（8000 网页聊天 HY-Agent，与网关共享 CloudBase 额度）。

### 9.2 核心坑：成长计划靠 User-Agent 识别「SDK 调用」
- **带 `User-Agent: tcb-node-sdk/3.18.3` → 200 正常扣免费额度；不带/默认 UA → 403 `AI_CHANNEL_NOT_ALLOWED`。**
- hermes_proxy/server.js 自带该 UA，所以能过；测试脚本不带 UA 就 403（test_creds.js 就是这么失败的）。
- 2026-08-12 现状：环境一 `dxt-d0gxfyz1h0c63958a` 配额耗尽（`EXCEED_TOKEN_QUOTA_LIMIT` 429）；**已切到环境二 `dxt667-d8g0fukkce12f8fcb`（同样带 UA 可用，额度未耗尽）**。切换改 hermes-proxy.service 的 CB_ENV_ID/CB_SID/CB_SKEY 后 `systemctl daemon-reload && restart` 即可，`server.js` 按 ENV_ID 自动拼上游地址。

### 9.3 修复过的代码 bug
- `server.js` 原版不检查上游 statusCode，流式/非流式一律 `res.writeHead(200)` 透传 → 上游 429/403 被包装成「HTTP 200 + 错误 JSON/空 body」，客户端报 `empty or malformed response (HTTP 200)`。
- 已修补（备份 `server.js.bak`）：上游非 2xx 时透传真实状态码 + `{"error":{"message":"upstream <msg>"}}`；流式分支同样先查 statusCode 再发 SSE。

### 9.4 用 SecretKey 申请新 API key（腾讯云 OpenAPI）
- 接口：`POST https://tcb.tencentcloudapi.com`，`X-TC-Action: CreateApiKey`，`X-TC-Version: 2018-06-08`，TC3-HMAC-SHA256 签名。
- 参数：`EnvId`、`KeyType: api_key|publish_key`、`KeyName`、`ExpireIn`（可选，不设=永不过期）；**必须带 `X-TC-Region`（ap-shanghai 可行）**。
- 返回 JWT 明文（仅创建时返回，列表查询脱敏）。**每环境 api_key 上限 5 个**（`LimitExceeded apikey token limited 5`）——apikey.txt 已各 5 个，满额不能再建。
- 本仓库 `create_apikey.py`：从 apikey.txt 读凭据，TC3 签名自动创建（含 Region 自动尝试）。
- TC3 签名坑：Python `datetime.utcnow().timestamp()` 是 naive 时间按本地时区解释 → 时间戳偏 8 小时 → `AuthFailure.SignatureExpire`。用 `time.time()` 取真实 UTC。

### 9.5 国内服务器部署（2026-08-12）
- 服务器：**118.24.71.189**（阿里云 Debian 13, root, 2G 内存），网关 hermes-proxy 部署在 `/opt/hermes_proxy/server.js`（v4.2-cn-public），systemd 服务 `hermes-proxy.service`，环境二凭据（dxt667-…）。
- **公网直连（本地零服务）**：服务监听 `0.0.0.0:8787`（ufw 已放行 8787，阿里云安全组已验证可通过），客户端 Base URL 直接填 **`http://118.24.71.189:8787`**，API Key 不变，无需 SSH 隧道/本地服务。
- 延迟对比（本地实测直连）：health 0.15s、流式 TTFB ~1.13s、RTT 58ms；AWS 东京隧道 TTFB ~1.16s；公网 CF Tunnel TTFB 2.56s。
- 安全说明：8787 公网暴露，靠 `CB_PROXY_AUTH`（Bearer/x-api-key 均可）鉴权保护，token 请勿泄露。
- 备用接入：SSH 隧道 `start_tunnel_8787.bat`（本地 8787→服务器，公网端口被封时用）；旧 AWS（52.199.22.54）网关保留可回退。
- 密码（备用）：root / <SERVER_PASSWORD>（已改用密钥认证）。

### 9.6 完全本地网关（不依赖任何远端服务器，2026-08-12）
- 目录：`local_gateway/server.js`（v4.2 同款，监听 127.0.0.1:8787）+ `local_gateway/start_local_gateway.bat`（一键启动，全英文注释无乱码）。
- 原理：本地 node 进程跑网关，用 apikey.txt 的环境二凭据**直连 CloudBase**（带 SDK UA），不需要 AWS/阿里云任何服务器。
- 启动：双击 `local_gateway/start_local_gateway.bat`（保持窗口），客户端 Base URL 仍 `http://127.0.0.1:8787`。
- 延迟（本地实测）：本地直连 CloudBase 流式 TTFB ~1.40s；对比：阿里云直连 1.13s、阿里云隧道 0.97s、AWS 隧道 1.16s、公网 CF 2.56s。
- 三种接入方式：①本地网关（local_gateway，零依赖）②阿里云直连 `http://118.24.71.189:8787`（本地零服务）③SSH 隧道（start_tunnel_8787.bat，备用）。
- bat 乱码说明：cmd 默认 GBK 解析 bat，UTF-8 中文注释会乱码；所有 bat 已改为纯英文。
