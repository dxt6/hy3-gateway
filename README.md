# CloudBase hy3 LLM 网关（hy3-gateway）

> 让 Claude Code / Claude Desktop / 任意 OpenAI-或-Anthropic 兼容客户端，稳定调用腾讯云开发「小程序成长计划」赠送的 hy3 系列大模型（两个账号共 10 亿 token）。
> 本 README 面向**接手的 AI Agent / 开发者**：读完即可了解现状、接入、运维与历史。

---

## 一、当前运行状态（接手必读）

| 项 | 值 |
|---|---|
| **推荐接入（生产·公网直连）** | `http://118.24.71.189:8787`（阿里云服务器，公网直连，**不受域名备案限制**，本地零依赖，适合 WorkBuddy / codex / Claude 等所有客户端） |
| 备用接入（已停用·历史 502 源） | `https://hy3gateway.dxt116.dpdns.org`（Cloudflare Tunnel → 阿里云 8787；**已于 2026-08-13 停用**，且大陆未备案域名直连会被阿里云按 SNI 拦截，不建议再用） |
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
Base URL: http://118.24.71.189:8787
API Key:  <CB_PROXY_AUTH 的值>
模型:     任意（统一回落 hy3-preview，含 o4-mini / gpt-5-codex 等未登记名）
```
- 请求体 `input`（字符串或消息数组 / `input_text` 结构）自动转 chat 消息；`instructions` 作为 system 提示；`tools`(function)、`max_output_tokens`、`temperature`、`top_p`、`tool_choice` 透传。
- 流式返回**完整标准 Responses SSE 事件序列（9 个）**：`response.created → response.in_progress → response.output_item.added → response.content_part.added → response.output_text.delta* → response.output_text.done → response.content_part.done → response.output_item.done → response.completed`。
  - **协议要点（codex 严格客户端实测验证）**：每个事件的 `data` 必须带**顶层 `type` 字段**（与事件名一致，codex 按 `data.type` 分发）；`response.created / response.in_progress / response.completed` 三个事件的 payload 必须把整个 response 对象**嵌套在 `response` 字段**里（`{"type":"response.completed","response":{...}}`），不能平铺顶层——否则 codex 报 `stream closed before response.completed`。
- 模型名不认时统一回落 `hy3-preview`（网关本质单后端 hy3-preview 代理），避免上游拒绝。
- **codex 0.147 默认 WebSocket 优先**：会先 `wss://.../responses` 升级（网关不支持 WS → 502），重试 5 次后才回退 HTTPS，每次请求白等 ~15s。为免空等，codex 侧 `~/.codex/config.toml` 需用自定义 provider 且 `supports_websockets = false`：`base_url` 指向隧道、`wire_api="responses"`、`experimental_bearer_token` 用网关 token（CB_PROXY_AUTH 值）。**网关侧双保险**：`handle` 现已对 WebSocket 升级请求（`Connection: Upgrade`）直接返回 426，即使客户端仍发 WS 也会立刻回退 HTTPS，不再卡 5 次(~15s)重试风暴（2026-08-13 15:24 部署）。**注：Cloudflared 隧道已于 2026-08-13 停用，WS 经隧道 502 这道坑随之消失；426 守卫仍保留，仅对直连网关的 WS 升级生效（兜底）。当前 codex 走 `openai_http` provider（HTTPS-only，不发 WS），最稳。**

---

## 二、架构

```
Claude Code / Claude Desktop / 任意客户端
        │  Anthropic /v1/messages 或 OpenAI /v1/chat/completions
        ▼
┌──────────────────────── 网关 hermes_proxy (v5.3) ────────────────────────┐
│ 鉴权(token) → 模型映射(→hy3) → 协议转换(Anthropic↔OpenAI)                │
│ 上下文保护(默认全保留/250K安全阀) → 429退避重试(3次) → 并发信号量(默认4)  │
│ 工具调用(tool_use↔tool_calls) / count_tokens / 流式SSE双向转换           │
│ ★视觉分流：检测到图片(image_url) → 路由 VISION_BASE_URL（智谱 GLM-4V-Flash）│
└──────────────┬───────────────────────────────────────────────────────────┘
               │ 纯文本请求：@cloudbase/node-sdk app.ai().modelRequest()
               │ 带图请求：HTTP 直连 OpenAI 兼容视觉 API（默认智谱）
               ▼
        CloudBase AI 网关（hy3，扣成长计划免费额度）    +   视觉 API（GLM-4V-Flash，免费档）
```

另一套独立功能：`relay.js`（本地多代理 key 中继，127.0.0.1:58046，给多个本地 agent 分配独立 key 做并发隔离，详见 §六）。

---

## 三、核心机制（网关能力清单）

1. **SDK 原生调用**（关键！）：上游用 `app.ai().modelRequest({url, data, stream, timeout})`（`@cloudbase/node-sdk`，`region: 'ap-shanghai'`，每次请求新建 `tcb.init`）。这是官方「云开发 SDK 调用」路径，成长计划才认——**不要改回自己拼 HTTP**（会被 403/限流）。
2. **模型映射**：`claude-haiku-4-5`、`gpt-4o`、`deepseek-chat` 等 30+ 常见名 → **hy3-preview**（实测最快，工具调用正常；hy3 也可用但慢 2.4x）。
3. **双协议**：`/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI），流式/非流式全支持，SSE 事件序列完整（含 content_block_stop，Claude Code 校验严格）。
4. **工具调用**：tools 定义、tool_use/tool_result 多轮回传、流式 input_json_delta 分片，全部双向转换。
5. **上下文保护（已改为保守策略，勿退回旧版）**：`trimContext` 默认**完全不动 messages，上下文 100% 保留**；仅两层防护——① 单条 `tool_result` 超 `SINGLE_TOOL_MAX=32000` 字符时截断该条；② 估算 token（字符/3）超 `HARD_CTX_EST=250000` 才从头部成对删除最旧轮次并打 `[hermes][WARN] context OVERSAFE-TRIM` 日志。旧版本曾静默截断到 32K 导致「模型忘记前文」，已废弃。
6. **上游瞬时错误重试 + 并发控制**：命中可重试的瞬时错误（429/限流，**以及**上游 5xx、502/500/503/504、`network` 类、JSON-RPC `code:-32603/-32001` 内部/网络错误、`category:internal/network`）指数退避重试 3 次（1s/2s/4s）；**上游即便返回 HTTP 200 + 错误体（如 `{code:-32603,message:"Internal error"}`）也会当作失败重试**；明确的请求/参数错误（4xx、invalid、too long）不重试；但**该后端偶发 `400`（`Request failed with status code 400`）多为瞬时抖动，现归类为可重试**（实测同请求稍后 curl 即 200，日志曾见 1 秒内 12 个 400→502 的瞬时窗口）；重试耗尽或确属真错误时，网关抛出 `UpstreamError(真实状态码)` 透传**真实 HTTP 状态**而非一律 502，避免 codex 误判网络错误触发重试风暴。重试前后打印 `[hermes][UPSTREAM-ERR]/[UPSTREAM-EXC]` 日志，便于直接定位上游真因。并发信号量默认 4，排队不报错。
7. **count_tokens**：`/v1/messages/count_tokens` 返回估算值（Claude Code 依赖此端点）。
8. **OpenAI Responses API**：`/responses` 与 `/v1/responses` 兼容 codex 等客户端——`responsesToChat` 把 `input` 转 chat 消息、`chatToResponses` 把上游结果转 Responses 形状、流式用 `callUpstream(chat,true)` 的 reader 包成 Responses SSE 事件；模型统一回落 hy3。
9. **视觉能力（Vision，2026-08-15 新增）**：配置 `VISION_API_KEY`（默认接智谱 GLM-4V-Flash 免费档）后，带图片的请求自动路由到视觉上游。覆盖三条路径：`/responses`（codex 的 `input_image`，含**顶层** `{"type":"input_image","image_url":...}` 结构——原实现只认 content 数组内的图片，已补）、`/v1/messages`（Anthropic `image` 块 base64/url 两种 source 都转）、`/v1/chat/completions`（原生 `image_url`）。纯文本请求 100% 仍走 CloudBase hy3，不消耗额外额度；不配 key 则视觉完全关闭。视觉上游用 HTTP 直连 + 简单重试（瞬时 5xx 退避 2 次），返回形态与 hy3 一致，SSE→Responses/Anthropic 转换代码零改动。自测脚本 `test_vision_mock.js`（本地 mock OpenAI 兼容端点）。
   - **codex 特殊点（踩坑已修）**：codex 不走顶层 `tools`，而是用 Responses API 的 `additional_tools` 字段带**内置工具**（`{"type":"additional_tools","role":"developer","tools":[{...}]}`），常见一个 `type:"custom"` 的 `exec`（V8 沙箱）及 `wait` / `request_user_input` 等 function 工具。转换规则：`additional_tools` 里的 function 工具并入 chat 顶层 `tools`；**custom 工具也暴露为 function 工具**（缺省 schema `{code:string}`，让上游能正式发起 tool_call，网关只转发、执行在客户端）；`role:"developer"` 当 system 处理。`tool_choice` 守卫：**只要有 `tool_choice` 却没有可用 function 工具就删掉 `tool_choice`**，否则上游 chat/completions 报 `tools is required when tool_choice is set` → 502。
   - **工具调用（实测可用）**：上游 `delta.tool_calls` 流式转发——function 工具发 `function_call` 项（`function_call_arguments.delta/done`），custom 工具（exec）发 **`custom_tool_call` 项**（`custom_tool_call_input.done`，input 为原始 JS，`{code:...}/{string:...}` 单键对象自动解包）；多轮往返支持 `function_call/custom_tool_call` + `function_call_output/custom_tool_call_output`（custom 工具的 input 回传时包成 `{code:...}` 对象，因上游会 `json.loads(arguments).items()`）。本机 codex exec 实测：12*13→156、数组排序求和、**curl.exe 抓取 example.com 标题、创建/读取文件**均正常。
   - **坑：custom 工具 description 必须完整透传**（不要截断）——exec 的正确用法（`text()` 输出、`tools.exec_command()` 嵌套、隔离区无 console/无网络、Windows 用 `curl.exe` 而非 PowerShell 的 `curl` 别名）全在描述里，截断会让上游写错代码（`import()`/`console.log`）导致工具静默失败。
   - 已知限制：上游模型是 hy3-preview（工具可用性取决于它）；codex 本地若报 `failed to spawn code-mode host`，需把 `AppData\Local\OpenAI\Codex\bin\<hash>\codex-code-mode-host.exe` 复制到 `~/.codex/.sandbox-bin/`。

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
| 08-13 07:18 | **codex 仍 502（真因）** | 诊断日志抓到 `[responses] FAIL err=tools is required when tool_choice is set`。真因：codex 用 Responses API 的 `additional_tools` 带 `type:"custom"` 的 `exec` 工具并设 `tool_choice`，`responsesToChat` 把 `additional_tools` 整段丢弃→顶层 `tools` 空→上游 chat/completions 拒。修复：`additional_tools` 的 function 工具并入顶层 tools；custom 降级成 system 消息；**无可用 function 工具时删掉 tool_choice**。模拟 codex 请求实测 200 |
| 08-13 07:25 | **流式断流 + trimContext 被回退（两处）** | (a) codex 多轮流式报 `stream closed before response.completed`：旧流式 `catch` 出错只 `res.end()` 不发 `response.completed`。修复：累积 delta 文本，catch 中改发 `response.completed`（带已累积文本）+ 打印 `[responses][stream] FAIL` 捕获真实上游错误。(b) 上一轮「还原基线」误用 `server.js.bak_responses_good`（含旧 `MAX_CTX_EST=32000` 静默截断），把线上 `HARD_CTX_EST=250000` 保守版**回退**了。已还原保守版。两者已部署并 `IDENTICAL_TO_LIVE` |
| 08-13 07:31 | **断流真因 = 流式事件序列不完整 + 诊断日志被误删** | 抓到 `[responses] IN ... nMsgs=19` 证明 codex 请求**能到达网关**（之前日志全空是因为"还原基线"用的是不含 `[responses] IN/FAIL` 的干净 bak，把诊断日志连带删了）。真因：网关只发 `created/in_progress/delta/completed`，缺 OpenAI Responses 规范必需的 `output_item.added` / `content_part.added` / `content_part.done` / `output_item.done`，codex 严格客户端收裸 delta 找不到 item 上下文即中断。修复：补全完整事件序列；恢复 `[responses] IN` 诊断日志（console.log 确保进 journald）。隧道流式实测事件序列完整 |
| 08-13 07:45 | **codex 流式断流（最终根因 = prefill 期 idle 超时）** | 前面几轮把"事件序列不完整/上游错误"当根因都修了，仍报 `stream closed before response.completed`。实测定位：`handleResponses` 流式分支先 `await callUpstream(chat,true)`（上游 prefill，**codex 长上下文可达数十秒**）才 `res.writeHead`——prefill 期间客户端**收不到任何字节（无 HTTP 响应头）**，被 Cloudflare/客户端 idle 超时掐断。修复：把 `writeHead` + 即时 `: ping` + 心跳（每 3s 一条 SSE 注释）**整体提前到 `await callUpstream` 之前**，并让心跳常驻整条流（覆盖 prefill 与生成期任何停顿）；另补全规范事件 `response.output_text.done`。经隧道实测：headers 立即发出（response.created 由 3.2s 降到 ~0.9s），`: ping` 每 3s 穿透 Cloudflare 到达客户端，48s 长流完整收到 `response.completed` |
| 08-13 07:56 | **codex 流式断流（真正最终根因 = 事件 payload 缺 type + response 包装；本机直接调 codex 复现）** | 前一轮修完 prefill 后 codex **仍**报 `stream closed before response.completed`。本机直接跑 codex 0.147 复现：①codex 传输层 **WebSocket 优先**，先 `wss://.../responses` 升级（网关不支持 WS）→ 502×6 → 回退 HTTPS；②回退后网关虽发完 `response.completed`（日志 `STREAM_DONE completed=1`/`RES_ENDED`），codex 却**按 `data.type` 分发事件**——我们所有事件缺顶层 `type` 字段，且 `created/in_progress/completed` 的 payload 未把 response 对象嵌套在 `response` 字段（真实 API 结构），codex 识别不了完成事件，nMsgs 逐次+1 反复重试。修复：`push` 助手自动注入 `type:<事件名>`；三个 response 级事件改为 `{response:{...}}` 嵌套。验证：本机 `codex exec` 经隧道正常返回（`正常` 与斐波那契代码），无断流；配合 `~/.codex/config.toml` 的 `supports_websockets=false` 自定义 provider，WS 502 重试也消失 |
| 08-13 08:18 | **codex 工具调用打通（exec 真正执行）** | codex 一到工具调用就停的根因（实测三层）：①custom 工具（exec）被降级成 system 消息、未暴露为 function 工具 → hy3 无 exec 可调，只回文本或空白；②流式丢弃 `delta.tool_calls`，上游 tool_call 被吞；③即便转发，custom 工具在 Responses 规范里应产出 `custom_tool_call` 项（input 为原始输入），发 `function_call` 项会报 `tool exec invoked with incompatible payload`。修复：custom 工具暴露为 function 工具；流式转发 tool_calls 并按类型发 function_call / custom_tool_call 事件；custom 参数 `{code:...}/{string:...}` 单键对象解包为原始 JS；多轮往返支持 `*_output` 且 custom input 包 `{code:...}`（上游要 `json.loads(arguments).items()`）。另：本地 `~/.codex/.sandbox-bin` 缺 `codex-code-mode-host.exe`（已从 AppData 复制补齐，否则 exec 报 failed to spawn code-mode host）。本机 codex exec 实测：12*13→156、数组排序求和→[1,2,4,5,8]+20，全链路无 FAIL |
| 08-13 08:30 | **codex 网络抓取/命令行工具修复（exec 描述被截断）** | exec 计算类已通，但网络抓取/命令行仍失败：codex 反馈"exec 没有可见输出"，连续多轮 exec 重试无果。根因：网关暴露 custom 工具（exec）时把 description 截断到 500 字符，丢掉 exec 正确用法关键说明（text() 输出、tools.exec_command() 嵌套、无 console/无网络、Windows 用 curl.exe 而非 curl 别名），hy3 只能猜写法（import()/console.log/隔离区内 fetch）静默失败。修复：description 完整透传不截断。实测：curl.exe 抓 example.com → 12s 返回 Example Domain；创建/读取 C:/Temp 文件成功。另：110s 测试超时是测试自身限制（交互使用无超时） |
| 08-13 12:26 | **codex 报 `Error Code:10000 / code:-32603 Internal error`（上游瞬时内部错误）** | 现象：用户端弹"自定义模型 hy3 错误，请切换模型或重试"，错误体 `{code:-32603,message:"Internal error",data:{category:"internal"}}`。诊断：服务端 active(running)、本地实测网关 200 已恢复；日志无该次请求记录（200+error body 被 `callUpstream` 裸透传、不走 502 catch，故无 non-200 访问日志）。根因：上游 CloudBase(hy3) 瞬时内部错误，网关原本只透传 + 仅对 429 重试，对 -32603/502/network 类不重试、也不打印上游错误。修复：`callUpstream` 扩展重试判定 `isTransientUpstreamError`（覆盖 5xx/-32603/-32001/network/Internal error，排除 4xx/参数错误），并对"200+错误体"也当作失败重试；重试/失败均打印 `[hermes][UPSTREAM-ERR]/[UPSTREAM-EXC]` 日志。已部署 `IDENTICAL_TO_LIVE`(md5 32d289f0)，冒烟 200。注：若请求根本未到达网关（Cloudflare 隧道层瞬时故障），则靠 codex/CloudBase 自带 "Retry once" 兜底 |
| 08-13 15:18 | **codex 又报 `wss://.../responses` 502（WS 重试风暴复发）** | 根因：`config.toml` 第6行 `model_provider` 被改回内置 `openai`（用户桌面端切过模型/provider 或还原备份），`openai_http`(HTTP-only) 段虽在但未生效 → codex 仍 WS 优先 → Cloudflare 隧道 502。修复：第6行改回 `openai_http` 使其顶层生效；并用真实桌面 codex(`AppData\Local\OpenAI\Codex\bin\8e8bf206e63ac436\codex.exe`) 实跑验证全程无 websocket/Reconnecting/wss 日志。经验：**每次在 GUI 切模型/provider 后要回查第6行仍是 `openai_http`**，否则 WS 502 复发 |
| 08-13 15:24 | **网关侧加 WebSocket 升级 426 守卫（双保险）** | 即便 `model_provider` 又被改回 `openai`，codex 发 `wss://.../responses` 也会被网关 `handle` 直接 426（不再卡 5 次~15s 重试风暴、不再被 CF 502）。`handle` 顶部检测 `Connection: Upgrade` → 426 + `req.resume()`。部署后实测：WS 升级返回 `426`（原 502）、HTTPS `/v1/responses` 仍 `200`。`IDENTICAL_TO_LIVE`(md5 55389db3)。注：用户已切到 WorkBuddy 官方服务，此改动为将来复用我们的网关时兜底 |
| 08-13 16:22 | **502 真因修复：上游瞬时 400 进重试 + 真实状态码透传** | 日志 15:17 抓到 `GET /responses -> 502` 且伴随 `[hermes][UPSTREAM-EXC] Request failed with status code 400`——根因是 CloudBase 上游偶发 400（实测为瞬时抖动，同请求稍后 curl 即 200），但原 `isTransientUpstreamError` 把 400 判为不可重试 → `throw` → handler 统一包成 502 丢回 codex，codex 误判网络错误触发重试风暴（1 秒 12 个 502）。修复：`isTransientUpstreamError` 改为按显式 HTTP 状态码分类（400/408/409/425/429/5xx 瞬时可重试；401/403/404/422 不重试）；`callUpstream` 解析 `status code NNN` 重试 3 次（退避封顶 8s），耗尽/确属真错误时抛 `UpstreamError(真实状态码)` 由 handler 透传真实状态；两处 handler catch 用 `e.status`。部署 md5 74aba007，冒烟 200。commit af29728 |
| 08-15 01:00 | **视觉能力（Vision）接入** | codex/Claude Code 带图请求自动路由智谱 GLM-4V-Flash（免费）。新增：`VISION_*` 配置、`hasVision` 图片检测、`callVisionUpstream`（HTTP 直连 OpenAI 兼容 API + 重试）、`callUpstreamSmart` 智能分流；**修复 codex 顶层 `input_image` 被静默丢弃的 bug**（原 `responsesToChat` 只认 content 数组内图片）；Anthropic `image` 块（base64/url）转 `image_url`。三条路径（/responses、/v1/messages、/v1/chat/completions）全覆盖，流式/非流式均可。纯文本仍 100% 走 hy3。本地 mock 冒烟：带图路由 ✓ / Anthropic 图片块 ✓ / 流式 ✓ / 纯文本不误路由 ✓ |

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
| 工具调用停 / codex 一到工具调用就停 | ① custom 工具未暴露为 function 工具；② 流式丢弃 tool_calls；③ custom 工具须发 `custom_tool_call` 项而非 `function_call` | 已修复：exec 等 custom 工具暴露 + 流式转发 + 按类型发事件 + 多轮往返（详见历史 08-13 08:18 行） |
| 401 | token 不匹配 | 检查客户端 API Key = CB_PROXY_AUTH 值 |
| 502 | **先看日志里的耗时，能直接区分根因**（`journalctl -u hermes-proxy \| grep 502`） | 见下两行 |
| └ 502 耗时 <1s（如 340ms） | 上游**立即拒绝**：模型名不被 CloudBase 接受（未映射就透传）、请求体畸形 | 确认 `model: MODEL_MAP[b.model] \|\| 'hy3-preview'`（**不要**带 `\|\| b.model`，否则未登记名会透传被拒） |
| └ 502 耗时 ~14s 且伴 `retry 1..3/3 ... 429` | CloudBase 成长计划额度/并发耗尽，退避重试 3 次仍失败；客户端频繁重试会放大成「重试风暴」 | 稍等额度恢复；避免 codex 与 WorkBuddy 同时高并发；必要时升级额度 |
| 502 集中在一次部署前后 | （历史）`systemctl restart` 期间 origin 短暂下线 + Cloudflare 隧道回 502；**Cloudflared 隧道已于 2026-08-13 停用，此条不再适用**。现仅偶发上游抖动或部署重启瞬间，重启完成即恢复 | 部署尽量少 restart；如仍 502 优先看耗时区分上游瞬时错 |
| codex 流式 `stream closed before response.completed` | 上游 prefill 期间网关未发任何字节，客户端连接 idle 超时被掐断 | 网关已修：响应头 + 即时 `: ping` + 心跳在 `await callUpstream` 之前发出。若仍现，抓 `[responses] IN / STREAM_DONE / RES_ENDED` 日志：网关发完 `response.completed`（日志 `completed=1` 且 `RES_ENDED`）说明是隧道/客户端侧超时；未发则看 `[responses][stream] FAIL` 取上游真因 |
| `Error Code:10000` / `code:-32603 Internal error` / `data.category:"internal"` | 上游 CloudBase(hy3) **瞬时内部错误**，网关原样透传。与 502 同类，多为偶发 | 网关已加固：`callUpstream` 对 -32603/5xx/network 类自动重试 1-2 次（直接吸收），并打 `[hermes][UPSTREAM-ERR]` 日志。**用户侧直接重试即可**；若持续出现才需排查上游额度/模型状态 |

---

## 八、安全注意事项（接手必须遵守）

1. **凭据文件**（`apikey.txt`、`proxy-keys.json`、`local_gateway/start_local_gateway.bat`、服务器 systemd 里的 `CB_SID/CB_SKEY/CB_PROXY_AUTH`）**一律不进公开仓库**——`.gitignore` 已兜底，新增文件注意。
2. 仓库 `dxt6/hy3-gateway` 是**公开**的，README/代码里不要写明文密钥；`hermes_proxy_server_v5.js` 从环境变量读凭据，安全。
3. 阿里云 8787 公网暴露，靠 `CB_PROXY_AUTH` 鉴权；token 泄露 = CloudBase 额度被盗用，注意保管。
4. GitHub 推送：走 HTTPS + 本地代理 7897；remote 不带 token（用 GCM 或一次性 token URL）。
