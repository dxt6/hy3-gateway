const fs = require('fs');
const TXT = 'C:/Users/dongxiaotong/Desktop/大模型网关/apikey.txt';
const keys = fs.readFileSync(TXT, 'utf-8').split('\n').map(l => l.trim()).filter(l => l.startsWith('eyJ') && !l.includes(' '));
const key = keys[5]; // 取一个网关二 key 测流式

(async () => {
  console.log('--- OpenAI 流式 ---');
  const r = await fetch('http://127.0.0.1:58046/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: '用5个字介绍北京' }] })
  });
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
  console.log('SSE片段数:', (buf.match(/data:/g) || []).length, '| 末尾:', buf.trim().split('\n').slice(-3).join(' '));

  console.log('--- Anthropic 流式 ---');
  const r2 = await fetch('http://127.0.0.1:58046/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'hy3', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '用5个字介绍北京' }] })
  });
  const reader2 = r2.body.getReader(); const dec2 = new TextDecoder(); let buf2 = '';
  while (true) { const { done, value } = await reader2.read(); if (done) break; buf2 += dec2.decode(value, { stream: true }); }
  console.log('事件数:', (buf2.match(/event:/g) || []).length, '| 含 message_stop:', buf2.includes('message_stop'));
})();
