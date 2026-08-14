// Mock 视觉上游：模拟智谱 OpenAI 兼容端点，记录收到的请求并回显「是否含图片」
// 用法：node test_vision_mock.js   （监听 127.0.0.1:9999）
const http = require('http');
const seen = { total:0, vision:0, text:0 };
function hasImg(messages){
  for(const m of messages||[]){
    const c = m && m.content;
    if(Array.isArray(c)){ for(const b of c){ if(b && b.type==='image_url') return true; } }
  }
  return false;
}
const server = http.createServer((req,res)=>{
  let buf='';
  req.on('data',c=>buf+=c);
  req.on('end',()=>{
    seen.total++;
    let p={};
    try{ p = JSON.parse(buf); }catch(e){}
    const img = hasImg(p.messages);
    if(img) seen.vision++; else seen.text++;
    const model = p.model || '?';
    const auth = (req.headers['authorization']||'').slice(0,40);
    console.log('[MOCK] #'+seen.total+' model='+model+' stream='+!!p.stream+' img='+img+' auth='+auth);
    const text = img
      ? 'MOCK-VISION-OK：我看到你发的图片了（image_url 块已正确送达视觉上游），共 '+JSON.stringify(p.messages).match(/image_url/g).length+' 个图片块。'
      : 'MOCK-TEXT-ONLY：此请求无图片，不应走到视觉上游。';
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if(p.stream){
      res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      const send = (obj)=>res.write('data: '+JSON.stringify(obj)+'\n\n');
      send({ id:'mock-1', object:'chat.completion.chunk', created: Date.now(), model, choices:[{index:0, delta:{role:'assistant', content:''}, finish_reason:null}] });
      // 分片吐字，模拟真实流式
      const chunks = text.match(/.{1,10}/g) || [text];
      let i = 0;
      const t = setInterval(()=>{
        if(i >= chunks.length){
          clearInterval(t);
          send({ id:'mock-1', object:'chat.completion.chunk', created: Date.now(), model, choices:[{index:0, delta:{}, finish_reason:'stop'}] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        send({ id:'mock-1', object:'chat.completion.chunk', created: Date.now(), model, choices:[{index:0, delta:{content: chunks[i]}, finish_reason:null}] });
        i++;
      }, 20);
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        id:'mock-1', object:'chat.completion', created: Date.now(), model,
        choices:[{index:0, message:{role:'assistant', content:text}, finish_reason:'stop'}],
        usage
      }));
    }
  });
});
server.listen(9999, '127.0.0.1', ()=>console.log('[MOCK] vision upstream on http://127.0.0.1:9999/v1/chat/completions'));
process.on('SIGINT', ()=>{ console.log('\n[MOCK] seen=', JSON.stringify(seen)); process.exit(0); });
