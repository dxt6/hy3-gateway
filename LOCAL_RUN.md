# hy3-gateway 本地运行指南（LOCAL_RUN）

把网关跑在**本机**，绕开公网服务器那一层 cloudflared 隧道 + 弱机器，客户端延迟只剩 CloudBase 上游本身。本文件只讲本地运行所需的调整，**真实凭据不进仓库**（见下「安全」）。

## 1. 为什么本地跑
公网部署（`118.24.71.189`，Debian）前面套了 cloudflared tunnel → `localhost:8787`，再叠加服务器本身性能弱，多一跳且慢。
本地部署去掉隧道和公网服务器，客户端直连本机 `127.0.0.1:8787` 后再由网关调用 CloudBase，链路最短。

## 2. 依赖
- Node.js 18+（本机用 22.x 验证过）
- CloudBase 环境：`@cloudbase/node-sdk`、`ws`

```bash
npm install @cloudbase/node-sdk ws
```

## 3. 配置凭据（三步，不提交真实值）
1. 复制模板：`cp .env.example .env.local`（` .env.local` 已被 `.gitignore` 忽略）
2. 在 `.env.local` 填入：
   - `CB_ENV_ID` — 腾讯云 CloudBase 环境 ID
   - `CB_SID` / `CB_SKEY` — CloudBase 密钥（SecretId / SecretKey，保密）
   - `CB_PROXY_AUTH` — 网关鉴权 Token（客户端请求必带，可自定随机串）
   - `LISTEN` — 本地填 `127.0.0.1`；需局域网/外网访问才改 `0.0.0.0`
   - `MAX_CONCURRENCY` — 默认 `4`
   - `MAX_CTX_TOKENS` — 上下文软上限（token 估算，约 1 token ≈ 3 字符），**默认 `64000`**。上游 `hy3` 对超长上下文响应极慢（>100K token 需 1–2 分钟且偶发 500），客户端易超时报 `request failed`。超出上限时网关自动从头部删最旧轮次、并截断单条超长消息，把上游输入压短以提速。设 `0` 关闭裁剪（回到完全保留旧行为，仅建议排查时用）。
   - `VISION_API_KEY` — **视觉能力开关（可选）**。填了智谱 API Key 后，任何带图片的请求（codex 粘贴图片 / Claude Code 图片块）自动路由到视觉模型，纯文本请求 100% 继续走 hy3。去 `https://open.bigmodel.cn` 注册拿 Key（GLM-4V-Flash 有免费档）。可选 `VISION_BASE_URL`（默认智谱 OpenAI 兼容端点）、`VISION_MODEL`（默认 `glm-4v-flash`，付费可换 `glm-4v-plus`；换其他 OpenAI 兼容视觉供应商只需改这两个变量）。
3. （可选）设置 `SSL_CERT` / `SSL_KEY`（PEM 路径）即在本机 443 终止 TLS；本地一般留空用纯 HTTP。

> 不想用 `.env.local` 也行：直接复制 `start_local_gateway.example.cmd` / `.sh` 为 `start_local_gateway.cmd` / `.sh`，把占位符改成真实值即可。

## 4. 启动
**Windows（双击）：**
```bat
copy start_local_gateway.example.cmd start_local_gateway.cmd   :: 然后填 .env.local 或直接编辑本文件
start_local_gateway.cmd
```
**bash / Git Bash：**
```bash
bash start_local_gateway.example.sh          # 自动 source .env.local
# 或一行式：
CB_ENV_ID=... CB_SID=... CB_SKEY=... CB_PROXY_AUTH=... node hermes_proxy_server_v5.js
```
启动后监听 `http://127.0.0.1:8787`，日志打到 stdout。

## 5. 客户端怎么接
| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787` |
| Anthropic 路径 | `/v1/messages` |
| OpenAI Responses 路径（codex 等） | `/responses` |
| API Key / `Authorization: Bearer` | `CB_PROXY_AUTH` 的值 |

**所有路由都需要 Bearer 鉴权**（连 `/health`、`/models` 也要带），不带返回 `401`。

自测：
```bash
TOKEN=你的_CB_PROXY_AUTH
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:8787/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

## 6. 模型名映射
网关把常见 Claude / GPT / DeepSeek / 通义 / GLM / Kimi 等模型名统一映射到 CloudBase 内置的 `hy3`（成长计划只认内置模型）。即客户端照常说 `claude-sonnet-4-5`、`gpt-4o` 等，网关自动转。

> 当前上游模型为 `hy3`（2026-08-13 由 `hy3-preview` 改为 `hy3`，见 `hermes_proxy_server_v5.js` 第 17–27、157 行）。`/models` 返回列表首项即 `hy3`。若上游某环境无 `hy3` 只有 `hy3-preview`，把映射值改回 `hy3-preview` 即可。

## 6.5 视觉能力（Vision）
- **原理**：转换层把所有图片输入（codex 的 `input_image`、Anthropic 的 `image` 块、原生 OpenAI `image_url`）统一转成 OpenAI `image_url` 内容块；`callUpstreamSmart` 检测到消息含图片且配了 `VISION_API_KEY` → 路由到 `VISION_BASE_URL`（默认智谱 GLM-4V-Flash），否则照旧走 CloudBase hy3。
- **三条路径全覆盖**：`/responses`（codex）、`/v1/messages`（Claude Code）、`/v1/chat/completions`（任意 OpenAI 客户端）。流式/非流式都支持，上游返回格式与 hy3 一致，转换代码零改动。
- **codex 用法**：`codex "这张图里有什么？" path/to/image.png` 或拖图到会话；Claude Code 直接粘贴/引用图片。
- **自测**：`node test_vision_mock.js`（另开终端）+ 启动网关后，curl 带 `input_image` 的 `/responses` 请求，日志出现 `[vision] ROUTE model=glm-4v-flash` 即为路由成功。
- **关闭**：不填 `VISION_API_KEY` 即完全关闭，行为与旧版一致。

## 7. 安全
- 真实凭据只在 `.env.local` 与 `start_local_gateway.cmd` / `.sh` 中，这两个文件名已在 `.gitignore`，**绝不提交**。
- 仓库里只放模板：`.env.example`、`start_local_gateway.example.cmd`、本文件。
- `LISTEN=0.0.0.0` 会暴露到局域网/公网，务必配好 `CB_PROXY_AUTH` 并确认防火墙。

## 8. 与线上保持一致
根目录 `hermes_proxy_server_v5.js` 即线上运行版本（无差异）。若以后改了服务端逻辑，本地直接同步同一文件即可，无需额外搬运。
