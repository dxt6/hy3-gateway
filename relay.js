/**
 * relay.js — 本地 AI 网关代理（腾讯云开发「小程序成长计划」hy3）
 *
 * 原理（已实测验证）：
 *   用 SecretId/SecretKey 初始化 @cloudbase/node-sdk，走 SDK 的 modelRequest
 *   直接打到 https://<envId>.api.tcloudbasegateway.com/v1/ai/cloudbase/<协议>，
 *   被服务端识别为「云开发 SDK 调用」→ 成功扣成长计划免费额度。
 *   静态 JWT key 直连 HTTP 网关会被 403 (AI_CHANNEL_NOT_ALLOWED)，故一律不用 JWT。
 *
 * 并发隔离：
 *   每个 env（网关环境）持有一个并发信号量（MAX_CONCURRENCY，默认 5）。
 *   代理 key agent-01..05 -> 网关一(env1)；agent-06..10 -> 网关二(env2)；
 *   local-gateway -> 跨两个 env 选当前负载最低者（负载均衡）。
 *   单 key 超并发时请求排队等待，而不是 429；命中成长计划 429 时指数退避重试。
 */
'use strict';

const http = require('http');
const tcb = require('@cloudbase/node-sdk');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '58046', 10);
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '5', 10);
const APIKEY_FILE = process.env.APIKEY_FILE
  || path.join(__dirname, 'apikey.txt');
const MODEL = process.env.MODEL || 'hy3';

// ---------------------------------------------------------------------------
// 1) 解析 apikey.txt
//    结构：区块「一：」「二：」各含 base URL / SecretId / SecretKey / 若干 JWT
// ---------------------------------------------------------------------------
function parseApiKeyFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const envs = [];
  let cur = null;
  let keyBuf = null; // 'secretId' | 'secretKey'
  let jwtCount = 0;
  const pushKey = (k) => { if (cur && k) cur.keys.push(k); };

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s === '一：' || s === '二：' || s === '一:' || s === '二:') {
      if (cur) envs.push(cur);
      cur = { name: s.replace(/：|:/g, ''), baseUrl: null, secretId: null, secretKey: null, keys: [] };
      keyBuf = null; jwtCount = 0;
      continue;
    }
    if (!cur) continue;
    if (/^https?:\/\//.test(s)) { cur.baseUrl = s; continue; }
    if (s === 'SecretId') { keyBuf = 'secretId'; continue; }
    if (s === 'SecretKey') { keyBuf = 'secretKey'; continue; }
    // JWT 行：以 eyJ 开头（可能带序号前缀如 "9：" 已在上一步切掉）
    if (s.startsWith('eyJ')) { jwtCount++; pushKey(s); keyBuf = null; continue; }
    // 序号行（如 "9：" 单独一行）忽略
    if (/^\d+[:：]$/.test(s)) { continue; }
    // 否则视为上一缓冲字段的值
    if (keyBuf === 'secretId') { cur.secretId = s; keyBuf = null; }
    else if (keyBuf === 'secretKey') { cur.secretKey = s; keyBuf = null; }
  }
  if (cur) envs.push(cur);
  return envs;
}

// ---------------------------------------------------------------------------
// 2) 构造每个 env 的调用器（带并发信号量 + 重试）
// ---------------------------------------------------------------------------
const PROXY_URL = process.env.HTTP_PROXY || process.env.http_proxy
  || 'http://127.0.0.1:7897';

function buildEnvCaller(env, idx) {
  // envId 从 baseUrl 提取：https://<envId>.api.tcloudbasegateway.com/...
  const m = env.baseUrl.match(/https?:\/\/([^.]+)\.api\.tcloudbasegateway\.com/);
  const envId = m ? m[1] : env.baseUrl;
  const base = `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`;
  // 每次请求新建 app（与已验证的 diag2 一致，避免复用实例的状态问题）
  function getAI() {
    const app = tcb.init({
      secretId: env.secretId,
      secretKey: env.secretKey,
      env: envId,
      region: 'ap-shanghai',
      proxy: PROXY_URL,
    });
    return app.ai();
  }

  // 并发信号量
  let active = 0;
  const queue = [];
  const acquire = () => new Promise((resolve) => {
    if (active < MAX_CONCURRENCY) { active++; resolve(); }
    else queue.push(resolve);
  });
  const release = () => {
    active--;
    if (queue.length) { active++; queue.shift()(); }
  };

  async function requestWithRetry(urlPath, body, stream) {
    const maxRetries = 3;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await acquire();
      try {
        const ai = getAI();
        const res = await ai.modelRequest({
          url: base + urlPath,
          data: body,
          stream: !!stream,
          timeout: 120000,
        });
        release();
        return res;
      } catch (e) {
        release();
        const msg = (e && e.message) || String(e);
        const is429 = /429/.test(msg) || /rate/i.test(msg) || /limit/i.test(msg);
        if (is429 && attempt < maxRetries) {
          attempt++;
          const backoff = Math.min(1000 * 2 ** attempt, 8000);
          console.error(`[env${idx + 1}] 429 退避重试 ${attempt}/${maxRetries} (${backoff}ms)`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
    }
  }

  return {
    name: env.name,
    envId,
    active: () => active,
    pending: () => queue.length,
    requestWithRetry,
  };
}

// ---------------------------------------------------------------------------
// 3) 代理 key 路由表
// ---------------------------------------------------------------------------
let envCallers = [];
const proxyKeys = {}; // proxyKey -> caller index (or 'lb')

function buildRouting() {
  envCallers = parseApiKeyFile(APIKEY_FILE).map(buildEnvCaller);
  envCallers.forEach((c, i) => {
    // agent-(i*5 + 1 .. i*5 + 5)
    for (let k = 1; k <= MAX_CONCURRENCY; k++) {
      const agentNo = i * MAX_CONCURRENCY + k;
      proxyKeys[`agent-${String(agentNo).padStart(2, '0')}`] = i;
    }
  });
  proxyKeys['local-gateway'] = 'lb';
  return envCallers;
}

// 选一个 caller：指定 key -> 固定；lb -> 当前 active 最小的 env
function resolveCaller(proxyKey) {
  if (proxyKey === 'local-gateway') {
    let best = 0;
    for (let i = 1; i < envCallers.length; i++) {
      if (envCallers[i].active() < envCallers[best].active()) best = i;
    }
    return best;
  }
  if (typeof proxyKeys[proxyKey] === 'number') return proxyKeys[proxyKey];
  return -1; // 未知 key
}

// ---------------------------------------------------------------------------
// 4) 协议转换
// ---------------------------------------------------------------------------

// OpenAI -> 内部 body（model 固定 hy3）
function openaiToInternal(body) {
  return {
    model: MODEL,
    messages: body.messages || [],
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    stream: !!body.stream,
  };
}

// 内部 OpenAI 格式响应 -> OpenAI 流式 SSE 块
function openaiSseChunk(content, finish, usage) {
  const obj = {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finish || null }],
  };
  if (content != null) obj.choices[0].delta = { content };
  if (usage) obj.usage = usage;
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

// Anthropic -> 内部 body
function anthropicToInternal(body) {
  // messages: [{role, content}] content 可能是 string 或 [{type:'text',text}]
  const messages = (body.messages || []).map((m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    }
    return { role: m.role, content: String(content) };
  });
  // system 单独作为 system message
  const out = { model: MODEL, messages, stream: !!body.stream };
  if (body.system) {
    out.messages = [{ role: 'system', content: body.system }, ...out.messages];
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  return out;
}

// 内部响应 -> Anthropic 流式 SSE 事件
function anthropicSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// 5) HTTP 服务器
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function handleOpenAI(req, res, body) {
  const proxyKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || 'local-gateway';
  const idx = resolveCaller(proxyKey);
  if (idx < 0) return sendJson(res, 401, { error: { message: 'invalid api key: ' + proxyKey } });
  const internal = openaiToInternal(body);
  const stream = internal.stream;

  if (!stream) {
    envCallers[idx].requestWithRetry('/chat/completions', internal, false)
      .then((r) => {
        // r 已是 OpenAI 格式（实测），直接透传
        sendJson(res, 200, r);
      })
      .catch((e) => sendJson(res, 502, { error: { message: (e && e.message) || String(e) } }));
    return;
  }

  // 流式：OpenAI SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  envCallers[idx].requestWithRetry('/chat/completions', internal, true)
    .then(async (streamObj) => {
      // streamObj 是 Web ReadableStream<Uint8Array>，每个 chunk 是 SSE 文本的 UTF-8 字节
      const reader = streamObj.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let usage = null;
      let finished = false;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // 按行切分 SSE
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { finished = true; continue; }
            let obj;
            try { obj = JSON.parse(payload); } catch (e) { continue; }
            if (obj.usage) usage = obj.usage;
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            const content = choice.delta ? choice.delta.content : null;
            const finish = choice.finish_reason || null;
            if (content != null) res.write(openaiSseChunk(content, null));
            if (finish) { res.write(openaiSseChunk('', finish, usage)); finished = true; }
          }
        }
      } catch (e) {
        res.write(openaiSseChunk('', 'error'));
      }
      if (!finished) res.write(openaiSseChunk('', 'stop', usage));
      res.write('data: [DONE]\n\n');
      res.end();
    })
    .catch((e) => {
      res.write(`data: ${JSON.stringify({ error: (e && e.message) || String(e) })}\n\n`);
      res.end();
    });
}

function handleAnthropic(req, res, body) {
  const proxyKey = (req.headers['x-api-key'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || 'local-gateway';
  const idx = resolveCaller(proxyKey);
  if (idx < 0) return sendJson(res, 401, { error: { message: 'invalid api key: ' + proxyKey } });
  const internal = anthropicToInternal(body);
  const stream = internal.stream;

  if (!stream) {
    envCallers[idx].requestWithRetry('/v1/messages', internal, false)
      .then((r) => {
        // r 已是 Anthropic 格式（实测），直接透传
        sendJson(res, 200, r);
      })
      .catch((e) => sendJson(res, 502, { error: { message: (e && e.message) || String(e) } }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Anthropic 流式的上游返回的是 Anthropic 原生 SSE（已实测 /v1/messages 非流式即为 Anthropic 格式）。
  // 因此这里把上游 SSE 事件原样透传给客户端（保留 event:/data: 行），仅确保结尾有 message_stop。
  envCallers[idx].requestWithRetry('/v1/messages', internal, true)
    .then(async (streamObj) => {
      const reader = streamObj.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let sawStop = false;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('event:')) {
              res.write(line + '\n');
            } else if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              res.write(line + '\n\n');
              if (payload === '[DONE]') { sawStop = true; continue; }
              try {
                const obj = JSON.parse(payload);
                if (obj.type === 'message_stop' || obj.type === 'content_block_stop') sawStop = true;
              } catch (e) { /* ignore */ }
            }
            // 其它控制行忽略
          }
        }
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: (e && e.message) || String(e) } })}\n\n`);
      }
      if (!sawStop) res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    })
    .catch((e) => {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: (e && e.message) || String(e) } })}\n\n`);
      res.end();
    });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function handleManage(req, res, url) {
  if (url === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      model: MODEL,
      envs: envCallers.length,
      proxyKeys: Object.keys(proxyKeys),
    });
  }
  if (url === '/keys') {
    return sendJson(res, 200, {
      model: MODEL,
      proxyKeys,
      assign: {
        'agent-01..05': '网关一 (env1)',
        'agent-06..10': '网关二 (env2)',
        'local-gateway': '负载均衡总入口',
      },
    });
  }
  if (url === '/status') {
    return sendJson(res, 200, {
      model: MODEL,
      maxConcurrencyPerEnv: MAX_CONCURRENCY,
      envs: envCallers.map((c, i) => ({
        name: c.name, envId: c.envId,
        active: c.active(), pending: c.pending(),
        capacity: MAX_CONCURRENCY,
      })),
    });
  }
  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (url === '/health' || url === '/keys' || url === '/status') {
      return handleManage(req, res, url);
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      return handleOpenAI(req, res, body);
    }
    if (url === '/v1/messages' && req.method === 'POST') {
      const body = await readBody(req);
      return handleAnthropic(req, res, body);
    }
    return sendJson(res, 404, { error: 'unknown endpoint: ' + url });
  } catch (e) {
    return sendJson(res, 500, { error: (e && e.message) || String(e) });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
buildRouting();
console.log(`[relay] 解析到 ${envCallers.length} 个网关环境，每个并发上限 ${MAX_CONCURRENCY}`);
console.log('[relay] 代理 key:', Object.keys(proxyKeys).join(', '));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] 本地网关已启动: http://127.0.0.1:${PORT}`);
  console.log(`[relay]   OpenAI : http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`[relay]   Anthropic: http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`[relay]   管理: /health /keys /status`);
});
