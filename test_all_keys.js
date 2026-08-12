/**
 * test_all_keys.js — 测试客户端（直连 127.0.0.1，不走系统代理）
 * 验证：10 个代理 key 双协议(OpenAI/Anthropic) 全部调通
 */
'use strict';
const http = require('http');

const PORT = process.env.PORT || 58046;
const HOST = '127.0.0.1';
const PROXY_KEYS = ['agent-01','agent-02','agent-03','agent-04','agent-05',
                    'agent-06','agent-07','agent-08','agent-09','agent-10','local-gateway'];

function post(path, headers, bodyObj, asStream) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      host: HOST, port: PORT, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (asStream) return resolve({ status: res.statusCode, raw: data });
        let json;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function testKey(proxyKey) {
  const results = {};
  // OpenAI
  try {
    const r = await post('/v1/chat/completions',
      { Authorization: 'Bearer ' + proxyKey },
      { model: 'hy3', messages: [{ role: 'user', content: 'ping，只回复 pong' }], temperature: 0.1 });
    results.openai = r.json && r.json.choices
      ? r.json.choices[0].message.content : ('status=' + r.status);
  } catch (e) { results.openai = 'ERR ' + e.message; }
  // Anthropic
  try {
    const r = await post('/v1/messages',
      { 'x-api-key': proxyKey, 'anthropic-version': '2023-06-01' },
      { model: 'hy3', max_tokens: 10, messages: [{ role: 'user', content: 'ping，只回复 pong' }] });
    results.anthropic = r.json && r.json.content
      ? r.json.content[0].text : ('status=' + r.status);
  } catch (e) { results.anthropic = 'ERR ' + e.message; }
  return results;
}

(async () => {
  console.log('=== 测试代理 key 双协议调通 ===');
  let ok = 0, fail = 0;
  for (const k of PROXY_KEYS) {
    const r = await testKey(k);
    const okO = typeof r.openai === 'string' && r.openai.includes('pong');
    const okA = typeof r.anthropic === 'string' && r.anthropic.includes('pong');
    console.log(`${k.padEnd(13)} OpenAI=${okO ? 'OK' : r.openai}  Anthropic=${okA ? 'OK' : r.anthropic}`);
    if (okO && okA) ok++; else fail++;
  }
  console.log(`\n结果: ${ok} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
