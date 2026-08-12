// 单 key(agent-01) 8 并发压力测试：复现「该API key超出并发限制」，验证 v4.1 修复
const http = require('http');

const PORT = 58046;
const KEY = 'agent-01';
const N = 8;

function call(i) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'hy3', stream: false,
      messages: [{ role: 'user', content: '用一句话回复：编号' + i }]
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        let code = res.statusCode;
        let msg = '';
        try { msg = JSON.parse(s).choices?.[0]?.message?.content?.slice(0, 20) || JSON.parse(s).error?.detail || ''; } catch {}
        resolve(`${code}${code === 200 ? ' ok:' + msg : ' err:' + msg}`);
      });
      res.on('error', () => resolve('client-err'));
    });
    req.on('error', () => resolve('req-err'));
    req.write(body);
    req.end();
  });
}

(async () => {
  const ps = [];
  for (let i = 1; i <= N; i++) ps.push(call(i));
  const rs = await Promise.all(ps);
  const ok = rs.filter(r => r.startsWith('200')).length;
  rs.forEach((r, i) => console.log(`#${i + 1} ${r}`));
  console.log(`\n结果：${ok}/${N} 成功，无 502 崩溃` + (ok === N ? ' ✅' : ' ⚠️'));
  process.exit(0);
})();
