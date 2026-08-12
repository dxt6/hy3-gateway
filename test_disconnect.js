// 模拟 AI agent 流式调用中途断开（取消/超时），验证网关不再崩溃自停。
const http = require('http');

const PORT = 58046;
const KEY = 'local-gateway';
const N = 12; // 重复触发断开的次数

function streamThenAbort() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '请写一段 200 字左右的自我介绍，用来测试流式输出。' }]
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        // 读到一点就突然断开，模拟 agent 取消请求
        if (n > 60) {
          req.destroy(); // 客户端主动断开
          resolve('aborted-at-' + n);
        }
      });
      res.on('end', () => resolve('ended-' + n));
      res.on('error', () => resolve('res-error'));
    });
    req.on('error', () => resolve('req-error'));
    req.write(body);
    req.end();
  });
}

(async () => {
  for (let i = 1; i <= N; i++) {
    const r = await streamThenAbort();
    process.stdout.write(`#${i} ${r}  `);
  }
  console.log('\n--- 全部断开触发完毕，检查网关是否还活着 ---');
  // 等一下，给流式中途错误留处理时间
  await new Promise(r => setTimeout(r, 1500));
  http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => {
    let s = '';
    res.on('data', d => s += d);
    res.on('end', () => {
      if (s.includes('"status":"ok"')) console.log('PASS: 网关仍存活 -> ' + s.trim());
      else console.log('WARN: 网关回包异常 -> ' + s);
      process.exit(0);
    });
  }).on('error', (e) => {
    console.log('FAIL: 网关已崩溃 -> ' + e.message);
    process.exit(1);
  });
})();
