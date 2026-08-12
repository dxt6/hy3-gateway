# CloudBase hy3 LLM 网关（hy3-gateway）

> 让 Claude Code / Claude Desktop / 任意 OpenAI-或-Anthropic 兼容客户端，稳定调用腾讯云开发「小程序成长计划」赠送的 hy3 系列大模型（两个账号共 10 亿 token）。
> 本 README 面向**接手的 AI Agent / 开发者**：读完即可了解现状、接入、运维与历史。

---

## 一、当前运行状态（接手必读）

| 项 | 值 |
|---|---|
| **推荐接入（生产·HTTPS 隧道）** | `https://hy3gateway.dxt116.dpdns.org`（Cloudflare Tunnel → 阿里云 8787，HTTPS，适合 WorkBuddy / codex 等走代理的客户端） |
| 推荐接入（生产·公网直连） | `http://118.24.71.189:8787`（阿里云服务器，公网直连，本地零依赖） |
| 备用接入 1 | 本地网关 `local_gateway/start_local_gateway.bat`（`http://127.0.0.1:8787`，仅依赖 CloudBase） |
| 备用接入 2 | SSH 隧道 `start_tunnel_8787.bat`（本地 8787 → 阿里云 8787，公网端口被封时用） |
| 网关版本 | **v5.3**（`hermes_proxy_server_v5.js`），模型映射目标 **hy3-preview** |
| 上游环境 | 环境二 `dxt667-d8g0fukkce12f8fcb`（账号 2） |
| 网关鉴权 Token | `CB_PROXY_AUTH`（在服务器 systemd 环境变量 / 本地启动脚本里，**不写进本 README**） |
| AWS 服务器 (52.199.22.54) | **已弃用**，不再维护 |
| 公网域名 (srv.dxt116.dpdns.org) | Cloudflare Tunnel → AWS，已弃用 |

**实测性能（2026-08-12，阿里云直连）**：小请求流式 TTFB ~1.0-1.5s；工具调用 ~1.3s；32K 上下文 ~3.0s。

### 客户端配置（Claude Code / Desktop 通用）
```
Base URL: http://118.24.71.189:8787   （本地网关则填 http://127.0.0.1:8787）
API Key:  <CB_PROXY_AUTH 的值>
模型:     任意（claude-haiku-4-5 / gpt-4o 等都会被映射到 hy3-preview）
```
鉴权兼容 4 种方式：`Authorization: Bearer`、裸 `Authorization`、`x-api-key`、`anthropic-api-key`。

### codex / OpenAI Responses API 客户端
网关额外实现了 OpenAI **Responses API** 端点 `/responses`（以及 `/v1/responses`），专供 codex 及任何走 Responses API 的客户端：
```
Base URL: https://hy3gateway.dxt116.dpdns.org        （或 http://118.24.71.189:8787）
API Key:  <CB_PROXY_AUTH 的值>
模型:     任意（统一回落 hy3-preview，含 o4-mini / gpt-5-codex 等未登记名）
```
- 请求体 `input`（字符串或消息数组 / `input_text` 结构）自动转 chat 消息；`instructions` 作为 system 提示；`tools`(function)、`max_output_tokens`、`temperature`、`top_p`、`tool_choice` 透传。
- 流式返回标准 Responses SSE 事件：`response.created → response.in_progress → response.output_text.delta → response.completed`。
- 模型名不认时统一回落 `hy3-preview`（网关本质单后端 hy3-preview 代理），避免上游拒绝。

---

## 二、架构

```
Claude Code / Claude Desktop / 任意客户端
        │  Anthropic /v1/messages 或 OpenAI /v1/chat/completions（流式+非流式）
        ▼
┌──────────────────────── 网关 hermes_proxy (v5.3) ────────────────────────┐
│ 鉴权(token) → 模型映射(→hy3-preview) → 协议转换(Anthropic↔OpenAI)        │
│ 上下文保护(默认全保留/250K安全阀) → 429退避重试(3次) → 并发信号量(默认4)  │
│ 工具调用(tool_use↔tool_calls) / count_tokens / 流式SSE双向转换           │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ @cloudbase/node-sdk app.ai().modelRequest()（SDK 原生调用）
               ▼
        CloudBase AI 网关（hy3-preview，扣成长计划免费额度）
```

另一套独立功能：`relay.js`（本地多代理 key 中继，127.0.0.1:58046，给多个本地 agent 分配独立 key 做并发隔离，详见 §六）。

---

## 三、核心机制（网关能力清单）

1. **SDK 原生调用**（关键！）：上游用 `app.ai().modelRequest({url, data, stream, timeout})`（`@cloudbase/node-sdk`，`region: 'ap-shanghai'`，每次请求新建 `tcb.init`）。这是官方「云开发 SDK 调用」路径，成长计划才认——**不要改回自己拼 HTTP**（会被 403/限流）。
2. **模型映射**：`claude-haiku-4-5`、`gpt-4o`、`deepseek-chat` 等 30+ 常见名 → **hy3-preview**（实测最快，工具调用正常；hy3 也可用但慢 2.4x）。
3. **双协议**：`/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI），流式/非流式全支持，SSE 事件序列完整（含 content_block_stop，Claude Code 校验严格）。
4. **工具调用**：tools 定义、tool_use/tool_result 多轮回传、流式 input_json_delta 分片，全部双向转换。
5. **上下文保护（已改为保守策略，勿退回旧版）**：`trimContext` 默认**完全不动 messages，上下文 100% 保留**；仅两层防护——① 单条 `tool_result` 超 `SINGLE_TOOL_MAX=32000` 字符时截断该条；② 估算 token（字符/3）超 `HARD_CTX_EST=250000` 才从头部成对删除最旧轮次并打 `[hermes][WARN] context OVERSAFE-TRIM` 日志。旧版本曾静默截断到 32K 导致「模型忘记前文」，已废弃。
6. **429 重试 + 并发控制**：命中 429/rate/limit 指数退避重试 3 次（1s/2s/4s）；并发信号量默认 4，排队不报错。
7. **count_tokens**：`/v1/messages/count_tokens` 返回估算值（Claude Code 依赖此端点）。
8. **OpenAI Responses API**：`/responses` 与 `/v1/responses` 兼容 codex 等客户端——`responsesToChat` 把 `input` 转 chat 消息、`chatToResponses` 把上游结果转 Responses 形状、流式用 `callUpstream(chat,true)` 的 reader 包成 Responses SSE 事件；模型统一回落 hy3-preview。

---

## 四、部署与运维

### 阿里云（生产）
- 服务器：`118.24.71.189`（Debian 13, root, 2G 内存；SSH 已换密钥认证，本地 `~/.ssh/id_ed25519` 已授权）
- 位置：`/opt/hermes_proxy/server.js`（即本仓库 `hermes_proxy_server_v5.js`）
- systemd：`hermes-proxy.service`，Environment 含 `CB_ENV_ID/CB_SID/CB_SKEY/CB_PROXY_AUTH/LISTEN=0.0.0.0`，监听 `0.0.0.0:8787`（ufw 已放行）
- 常用命令：`systemctl restart hermes-proxy`、`journalctl -u hermes-proxy -n 50`（查 429 重试/上下文截断日志）

### 本地网关（备用/零依赖）
- 双击 `local_gateway/start_local_gateway.bat`（全英文注释，环境变量内嵌在 bat 中——**该文件含凭据，勿提交到公开仓库**）

### 更新 / 回滚
- 更新：改 `hermes_proxy_server_v5.js` → 上传到 `/opt/hermes_proxy/server.js` → `systemctl restart hermes-proxy`
- 回滚：服务器 `/home/admin/hermes_proxy/` 或 `/opt/hermes_proxy/` 下保留了 `server.js.bak` ~ `bak6` 备份链
- 本地 `local_gateway/server_v5.js` 与根目录 `hermes_proxy_server_v5.js` 需保持同步

---

## 五、历史工作记录（2026-08-11 ~ 08-12）

| 时间 | 事件 | 关键点 |
|---|---|---|
| 08-11 | 本地 relay.js 网关加固 | 流式中断崩溃修复、并发 4、真流式 TTFB 1.2s |
| 08-11 晚 | 公网网关报「HTTP 200 空响应」 | 根因：CloudBase 成长计划**靠 User-Agent `tcb-node-sdk/3.18.3` 识别 SDK 调用**；server.js 不检查上游状态码把错误包装成 200（已修） |
| 08-12 00:10 | 环境一配额耗尽 | `EXCEED_TOKEN_QUOTA_LIMIT`；切环境二（带 UA 可用） |
| 08-12 00:15 | Claude Code 探测 429 | 模型名不在白名单统一报配额错误；v3 加模型映射 + Anthropic 协议转换 |
| 08-12 00:30 | 响应慢 | Cloudflare Tunnel 链路 2.56s；SSH 隧道方案 1.16s |
| 08-12 00:50 | 回复吐出来又消失 | SSE 缺 content_block_stop（已补） |
| 08-12 01:00 | 工具调用自己停 | 转换层丢 tools/tool_use/tool_result（v4 补齐） |
| 08-12 01:05 | tool call 解析失败 | 流式块 index 不连续（v4.1 动态分配） |
| 08-12 01:40 | webfetch 停 | count_tokens 端点被当聊天转发（v4.2 修复） |
| 08-12 12:30 | 部署阿里云 | 公网直连 0.0.0.0:8787，本地零服务 |
| 08-12 14:30 | 带上下文续对话卡死 | 会话 3.3MB / 95K token 挂死上游；v5.1 上下文保护（截断 96K→32K） |
| 08-12 14:50 | 问"你是谁"要 1 分钟 | prefill 与上下文线性增长；v5.2 截断阈值降到 32K |
| 08-12 14:55 | 整体卡顿 | 换 **hy3-preview**（快 2.4x）；v5.3 定版 |
| 08-12 | 上传 GitHub | `dxt6/hy3-gateway`（公开），敏感文件已 .gitignore |
| 08-13 | codex 502（缺 /responses） | 新增 OpenAI Responses API 兼容层（/responses + /v1/responses）：`responsesToChat/chatToResponses/handleResponses`；模型统一回落 hy3-preview；经隧道验证 200 |
| 08-13 06:52 | codex 报 502（第二轮） | 日志显示 `POST /responses -> 502 (~340ms)`，**快速失败非限流**：当时 live 仍把 `gpt-5-codex`/`o4-mini` 原样透传上游被拒。`fix_model.py` 改为无条件回落 hy3-preview 后，两个模型名实测均 200 |
| 08-13 06:56 | 同期另有 429 重试 | `retry 1..3/3 ... 429` 后 `POST /chat/completions -> 502 (8888ms)`：部署 restart 期间 origin 短暂下线 + 客户端重试放大，耗尽成长计划额度；07:00 后日志干净 |
| 08-13 07:15 | 复核收尾 | 隧道 `/health`+`/responses`+`/v1/responses` 全 200（1.9-2.1s）；live = GitHub `dcb8cd3` 合并版（含 `0fb2ece` 保守 trimContext）；README 修正过时的「截断 32K」描述；`.gitignore` 补一次性排障脚本 |

### 关键经验（踩坑结论）
- **成长计划 = 必须走 SDK 原生调用**（modelRequest）或带 SDK UA；HTTP 直连/JWT key 直连 = 403。
- **不认识的模型名统一报配额错误**（伪装成 EXCEED_TOKEN_QUOTA_LIMIT）——排查时先验模型名。
- **hy3 prefill 随上下文线性变慢**：96K→10s，32K→3s。长会话是慢的根源，建议 `/compact` 或新开对话。
- **Anthropic 流式协议很严格**：content_block_start/delta/stop 的 index 必须连续对应，缺一即解析失败。
- **腾讯云 OpenAPI CreateApiKey**：每环境 api_key 上限 5 个（已满）；TC3 签名时间戳必须真实 UTC。

---

## 六、relay.js（本地多 key 中继，独立功能）

- 用途：给多个本地 AI agent 分配独立代理 key（`agent-01..10` / `local-gateway`），1:1 映射真实 CloudBase key，并发隔离，总并发 10×4=40。
- 启动：`start_relay.bat`（127.0.0.1:58046）；凭据从 `apikey.txt` 读取（**该文件含密钥，勿提交**）。
- 接口：`/health`、`/keys`、`/status`。
- 与 hermes_proxy 关系：两者独立；relay.js 面向多 agent 本地分发，hermes_proxy 面向单网关服务器部署。当前主力是 hermes_proxy。

---

## 七、已知问题与排查速查

| 症状 | 原因 | 处理 |
|---|---|---|
| HTTP 200 空/畸形响应 | 上游错误被包装（旧版本 bug） | 已修复；先验模型名/配额 |
| 429 EXCEED_TOKEN_QUOTA_LIMIT | 模型名不认 或 额度/限流 | 换标准模型名（映射表内）；稍等重试；充值资源点 |
| 卡 1 分钟 | 上下文过大（prefill 随长度线性变慢） | `/compact` 或新开对话。注意：网关**不再**静默截断到 32K（会丢记忆），只在 >250K 时才动 |
| 模型「忘记」前文 | 旧版网关静默截断上下文到 32K | 已修（`0fb2ece`）：默认全保留，确认 live 的 `HARD_CTX_EST=250000` |
| 回复吐出来又消失 | SSE 序列不完整 | 已修复 v4.1；确认网关是 v5.3 |
| 工具调用停 | 转换层缺 tools 支持 | 已修复 v4；确认网关是 v5.3 |
| 401 | token 不匹配 | 检查客户端 API Key = CB_PROXY_AUTH 值 |
| 502 | **先看日志里的耗时，能直接区分根因**（`journalctl -u hermes-proxy \| grep 502`） | 见下两行 |
| └ 502 耗时 <1s（如 340ms） | 上游**立即拒绝**：模型名不被 CloudBase 接受（未映射就透传）、请求体畸形 | 确认 `model: MODEL_MAP[b.model] \|\| 'hy3-preview'`（**不要**带 `\|\| b.model`，否则未登记名会透传被拒） |
| └ 502 耗时 ~14s 且伴 `retry 1..3/3 ... 429` | CloudBase 成长计划额度/并发耗尽，退避重试 3 次仍失败；客户端频繁重试会放大成「重试风暴」 | 稍等额度恢复；避免 codex 与 WorkBuddy 同时高并发；必要时升级额度 |
| 502 集中在一次部署前后 | `systemctl restart` 期间 origin 短暂下线，Cloudflare 隧道回 502 | 正常现象，重启完成即恢复；部署尽量少 restart |

---

## 八、安全注意事项（接手必须遵守）

1. **凭据文件**（`apikey.txt`、`proxy-keys.json`、`local_gateway/start_local_gateway.bat`、服务器 systemd 里的 `CB_SID/CB_SKEY/CB_PROXY_AUTH`）**一律不进公开仓库**——`.gitignore` 已兜底，新增文件注意。
2. 仓库 `dxt6/hy3-gateway` 是**公开**的，README/代码里不要写明文密钥；`hermes_proxy_server_v5.js` 从环境变量读凭据，安全。
3. 阿里云 8787 公网暴露，靠 `CB_PROXY_AUTH` 鉴权；token 泄露 = CloudBase 额度被盗用，注意保管。
4. GitHub 推送：走 HTTPS + 本地代理 7897；remote 不带 token（用 GCM 或一次性 token URL）。
