// 测试 hy3-mcp.js 能否作为 MCP server 正常工作（模拟 Claude 桌面端的 stdio 调用）
'use strict';
const { spawn } = require('child_process');
const node = 'C:\\Users\\dongxiaotong\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';
const script = 'C:\\Users\\dongxiaotong\\Desktop\\大模型网关\\hy3-mcp.js';

const child = spawn(node, [script], {
  env: Object.assign({}, process.env, {
    HY3_RELAY: 'http://127.0.0.1:58046',
    HY3_PROXY_KEY: 'local-gateway',
    HY3_MODEL: 'hy3',
    NODE_PATH: 'C:\\Users\\dongxiaotong\\Desktop\\大模型网关\\node_modules',
  }),
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const responses = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) { try { responses.push(JSON.parse(line)); } catch (e) {} }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

// 1) initialize
send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
// 2) initialized notification
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
// 3) tools/call
setTimeout(() => {
  send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'chat', arguments: { message: '用一句话介绍你自己' } },
  });
}, 300);

setTimeout(() => {
  console.log('=== MCP responses ===');
  for (const r of responses) {
    if (r.id === 2 && r.result) {
      console.log('chat result:', r.result.content[0].text.slice(0, 300));
    } else if (r.id === 1) {
      console.log('initialize ok:', !!r.result);
    }
  }
  child.kill();
  process.exit(0);
}, 8000);
