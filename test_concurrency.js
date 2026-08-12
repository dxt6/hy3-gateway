// Multi-agent concurrency stress test: isolation + load balance + queueing
const http = require('http');
const PORT = process.env.PORT || 58046;

function req(path, key, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.end(data);
  });
}

(async () => {
  const body = { model: 'hy3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 };

  // 1) single proxy key, 8 concurrent (over the 5 limit) -> should queue, all 200
  const N = 8;
  const r1 = await Promise.all(Array.from({ length: N }, () => req('/v1/chat/completions', 'agent-01', body)));
  console.log('single key x' + N + ':', r1.join(','));

  // 2) master load-balance: 20 concurrent spread across 10 real keys
  const r2 = await Promise.all(Array.from({ length: 20 }, () => req('/v1/chat/completions', 'local-gateway', body)));
  console.log('master x20:', r2.filter(c => c === 200).length + '/20 ok');

  // 3) multi-agent: 4 agents x 6 concurrent = 24 across 4 real keys
  const keys = ['agent-01', 'agent-02', 'agent-03', 'agent-04'];
  const r3 = await Promise.all(keys.flatMap(k => Array.from({ length: 6 }, () => req('/v1/chat/completions', k, body))));
  console.log('4 agents x6 = 24:', r3.filter(c => c === 200).length + '/24 ok');
})();
