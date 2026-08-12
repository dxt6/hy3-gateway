/**
 * hy3-mcp.js — 把本地 hy3 网关（relay.js @127.0.0.1:58046）暴露为 MCP server
 * 供 Claude 桌面端通过 MCP 工具调用 hy3。
 *
 * 工具：chat
 *   参数: { message: string, system?: string, temperature?: number, max_tokens?: number }
 *   行为: 转发到 http://127.0.0.1:58046/v1/chat/completions（OpenAI 兼容）
 *        代理 key 用 local-gateway（负载均衡）；或设 HY3_PROXY_KEY 指定 agent-0X
 */
'use strict';
// 清空代理环境变量，确保直连 127.0.0.1 不被系统代理拐走（命中 502 坑）
delete process.env.HTTP_PROXY; delete process.env.http_proxy;
delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
delete process.env.ALL_PROXY; delete process.env.all_proxy;
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');

const RELAY = process.env.HY3_RELAY || 'http://127.0.0.1:58046';
const PROXY_KEY = process.env.HY3_PROXY_KEY || 'local-gateway';
const MODEL = process.env.HY3_MODEL || 'hy3';

function chatCompletion(message, system, temperature, maxTokens) {
  return new Promise((resolve, reject) => {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });
    const body = JSON.stringify({
      model: MODEL,
      messages,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens != null ? maxTokens : 2000,
    });
    const u = new URL(RELAY + '/v1/chat/completions');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + PROXY_KEY,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('relay ' + res.statusCode + ': ' + data.slice(0, 300)));
        try {
          const j = JSON.parse(data);
          const text = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : JSON.stringify(j);
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const server = new Server(
  { name: 'hy3-gateway', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'chat',
    description: '调用本地 hy3 大模型网关（腾讯云开发成长计划 hy3）。输入一句话，返回 hy3 的回答。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '发给 hy3 的用户消息' },
        system: { type: 'string', description: '可选的系统提示词' },
        temperature: { type: 'number', description: '可选，0~1，默认 0.7' },
        max_tokens: { type: 'number', description: '可选，最大回复 token，默认 2000' },
      },
      required: ['message'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  try {
    const text = await chatCompletion(args.message, args.system, args.temperature, args.max_tokens);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'hy3 调用失败: ' + (e && e.message ? e.message : e) }], isError: true };
  }
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 不要往 stdout 打日志，会破坏 MCP 协议；写到文件
  require('fs').appendFileSync(__dirname + '/hy3-mcp.log',
    new Date().toISOString() + ' hy3-mcp started (relay=' + RELAY + ', key=' + PROXY_KEY + ')\n');
})();
