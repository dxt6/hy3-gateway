const http = require('http');
const tcb = require('@cloudbase/node-sdk');

const ENV_ID = process.env.CB_ENV_ID || '';
const SECRET_ID = process.env.CB_SID || '';
const SECRET_KEY = process.env.CB_SKEY || '';
const AUTH_TOKEN = process.env.CB_PROXY_AUTH || '';
const PORT = 8787;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
const GATEWAY = 'https://' + ENV_ID + '.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions';

// CloudBase 成长计划只认内置模型；把常见 Claude/OpenAI 模型名映射到 hy3
const MODEL_MAP = {
  'claude-haiku-4-5':'hy3','claude-sonnet-4-5':'hy3','claude-opus-4-1':'hy3',
  'claude-3-5-sonnet':'hy3','claude-3-5-haiku':'hy3','claude-3-sonnet':'hy3',
  'claude-3-haiku':'hy3','claude-3-opus':'hy3','claude-2.1':'hy3','claude-2.0':'hy3',
  'claude-instant-1.2':'hy3','claude-instant-1':'hy3',
  'gpt-4o':'hy3','gpt-4o-mini':'hy3','gpt-4-turbo':'hy3','gpt-4':'hy3','gpt-3.5-turbo':'hy3',
  'deepseek-chat':'deepseek-v4-flash','deepseek-reasoner':'deepseek-v4-flash',
  'qwen-plus':'qwen3.5-flash','qwen-turbo':'qwen3.5-flash','qwen-max':'qwen3.5-flash',
  'glm-4':'glm-5.2','glm-4-plus':'glm-5.2','kimi':'kimi-k2.6','moonshot-v1-8k':'kimi-k2.6'
};
const BASE_MODELS = ['hy3','hy3-preview','deepseek-v4-flash','qwen3.5-flash','glm-5.2','kimi-k2.6','minimax-m3'];

function buildModels(){
  const set = new Set(BASE_MODELS.concat(Object.keys(MODEL_MAP)));
  return {object:'list',data:[...set].map(id=>({id,object:'model',created:0,owned_by:'cloudbase'}))};
}
function mapStop(fr){
  if(fr==='stop') return 'end_turn';
  if(fr==='length') return 'max_tokens';
  if(fr==='tool_calls') return 'tool_use';
  return 'end_turn';
}
function anthToolId(id){
  if(!id) return 'toolu_'+Math.random().toString(36).slice(2,14);
  return id.startsWith('toolu_') ? id : ('toolu_'+id);
}

// ---------- 并发信号量（给 CloudBase 留余量，避免并发超限） ----------
let active = 0; const queue = [];
function acquire(){ return new Promise(r=>{ if(active<MAX_CONCURRENCY){ active++; r(); } else queue.push(r); }); }
function release(){ active--; if(queue.length){ active++; queue.shift()(); } }

// ---------- 上游调用：SDK 原生 AI 调用（官方允许来源）+ 429 退避重试 ----------
async function callUpstream(payload, stream){
  const maxRetries = 3;
  let attempt = 0;
  while(true){
    await acquire();
    try{
      const app = tcb.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY, region: 'ap-shanghai', timeout: 280000 });
      const ai = app.ai();
      const res = await ai.modelRequest({ url: GATEWAY, data: payload, stream: !!stream, timeout: 280000 });
      release();
      return res;
    }catch(e){
      release();
      const msg = (e && e.message) || String(e);
      const isRetry = /429|rate|limit|quota|过于频繁|超出并发|too many|exceed/i.test(msg);
      if(isRetry && attempt < maxRetries){
        attempt++;
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        console.log('[hermes] retry '+attempt+'/'+maxRetries+' after '+backoff+'ms: '+msg.slice(0,120));
        await new Promise(r=>setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
}

// ---------- 请求转换: Anthropic -> OpenAI ----------
function anthToOpenAIMessages(msgs){
  const out = [];
  for(const m of msgs||[]){
    const content = m.content;
    if(Array.isArray(content)){
      if(m.role==='assistant'){
        const text = content.filter(b=>b.type==='text').map(b=>b.text||'').join('');
        const tcs = content.filter(b=>b.type==='tool_use').map(b=>({
          id: anthToolId(b.id), type: 'function',
          function: { name: b.name||'', arguments: JSON.stringify(b.input||{}) }
        }));
        if(text || tcs.length){
          const am = { role:'assistant', content: text||null };
          if(tcs.length) am.tool_calls = tcs;
          out.push(am);
        }
      } else {
        const text = content.filter(b=>b.type==='text').map(b=>b.text||'').join('');
        const results = content.filter(b=>b.type==='tool_result');
        if(text) out.push({ role:'user', content: text });
        for(const r of results){
          let rc = r.content;
          if(Array.isArray(rc)) rc = rc.map(b=>b.text||b.content||'').join('');
          out.push({ role:'tool', tool_call_id: anthToolId(r.tool_use_id), content: String(rc||'') });
        }
      }
    } else {
      out.push({ role: m.role==='assistant'?'assistant':'user', content: String(content||'') });
    }
  }
  return out;
}
function anthropicToOpenAI(p){
  const out = { model: MODEL_MAP[p.model]||p.model||'hy3', max_tokens: p.max_tokens||1024 };
  out.messages = anthToOpenAIMessages(p.messages);
  if(Array.isArray(p.tools) && p.tools.length){
    out.tools = p.tools.map(t=>({ type:'function', function:{ name: t.name||'', description: t.description||'', parameters: t.input_schema||{type:'object',properties:{}} } }));
  }
  if(p.tool_choice){ out.tool_choice = p.tool_choice.type==='auto'?'auto':(p.tool_choice.type==='any'?'required':{type:'function',function:{name:p.tool_choice.name}}); }
  if(p.stream!==undefined) out.stream = p.stream;
  if(p.temperature!==undefined) out.temperature = p.temperature;
  if(p.top_p!==undefined) out.top_p = p.top_p;
  // 上下文保护: 估算 token 超限则从头部成对截断 + 压缩超大 tool_result
  trimContext(out);
  return out;
}

// ---------- 上下文保护（防止超大历史把上游挂死） ----------
const MAX_CTX_EST = 96000;   // 估算 token 上限（hy3 窗口保守值）
const MAX_MSG_KEEP = 80;     // 最多保留消息条数
function trimContext(payload){
  const msgs = payload.messages;
  if(!Array.isArray(msgs) || !msgs.length) return;
  const est = () => Math.ceil(JSON.stringify(msgs).length / 3);
  if(est() <= MAX_CTX_EST) {
    // 单条 tool 内容超长也压缩
    compressBigToolResults(msgs);
    return;
  }
  // 从头成对删除(删 user+assistant 对, 保持 tool_use/tool_result 配对)
  let i = 0;
  while(msgs.length > MAX_MSG_KEEP && est() > MAX_CTX_EST && i < msgs.length - 2){
    msgs.splice(i, 2);
  }
  compressBigToolResults(msgs);
  console.log('[hermes] context trimmed: '+msgs.length+' msgs, est '+est()+' tok');
}
function compressBigToolResults(msgs){
  for(const m of msgs){
    const c = m.content;
    if(Array.isArray(c)){
      for(const b of c){
        if(b && b.type==='tool_result' && typeof b.content==='string' && b.content.length>4000){
          b.content = b.content.slice(0,4000)+'\n...[truncated by gateway]';
        }
      }
    }
  }
}

// ---------- 响应转换: OpenAI -> Anthropic ----------
function openAIToAnthropic(j, reqModel){
  const ch = j.choices && j.choices[0];
  const msg = ch && ch.message || {};
  const content = [];
  if(msg.content) content.push({ type:'text', text: msg.content });
  if(Array.isArray(msg.tool_calls)){
    for(const tc of msg.tool_calls){
      let input = {};
      try{ input = JSON.parse(tc.function.arguments||'{}'); }catch(e){ input = {_raw: tc.function.arguments}; }
      content.push({ type:'tool_use', id: anthToolId(tc.id), name: tc.function.name||'', input });
    }
  }
  return {
    id: 'msg_' + (j.id||('m_'+Date.now())),
    type: 'message', role: 'assistant', model: reqModel,
    content,
    stop_reason: mapStop(ch && ch.finish_reason), stop_sequence: null,
    usage: j.usage ? { input_tokens: j.usage.prompt_tokens||0, output_tokens: j.usage.completion_tokens||0 } : null
  };
}

// ---------- 流式: OpenAI SSE -> Anthropic SSE（块索引动态分配连续） ----------
function streamOpenAIToAnthropic(reader, decoder, res, reqModel){
  let buffer='', started=false, stopSent=false;
  const blocks = []; let nextIndex = 0;
  const toolByOpenAI = {};
  function sse(ev, data){ res.write('event: '+ev+'\ndata: '+JSON.stringify(data)+'\n\n'); }
  function textBlock(){
    let b = blocks.find(x=>x.type==='text');
    if(!b){ b = {index:nextIndex++, type:'text', opened:false, stopped:false}; blocks.push(b); }
    if(!b.opened){ sse('content_block_start',{type:'content_block_start',index:b.index,content_block:{type:'text',text:''}}); b.opened=true; }
    return b;
  }
  function toolBlock(oi, id, name){
    let b = toolByOpenAI[oi];
    if(!b){ b = {index:nextIndex++, type:'tool', id:anthToolId(id), name:name||'', opened:false, stopped:false, args:''}; blocks.push(b); toolByOpenAI[oi]=b; }
    if(name && !b.name) b.name = name;
    if(!b.opened){ sse('content_block_start',{type:'content_block_start',index:b.index,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}}); b.opened=true; }
    return b;
  }
  function closeAll(){ for(const b of blocks){ if(b.opened && !b.stopped){ sse('content_block_stop',{type:'content_block_stop',index:b.index}); b.stopped=true; } } }
  function finish(fr){
    closeAll();
    sse('message_delta',{type:'message_delta',delta:{stop_reason:mapStop(fr),stop_sequence:null},usage:{output_tokens:0}});
    sse('message_stop',{type:'message_stop'});
  }
  function onLine(line){
    if(!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if(!data || data==='[DONE]'){ if(data==='[DONE]' && !stopSent){ stopSent=true; finish(); } return; }
    let j; try{ j = JSON.parse(data); }catch(e){ return; }
    const ch = j.choices && j.choices[0];
    if(!started){
      sse('message_start',{type:'message_start',message:{id:'msg_'+(j.id||('m_'+Date.now())),type:'message',role:'assistant',model:reqModel,content:[],stop_reason:null,stop_sequence:null,usage:null}});
      started = true;
    }
    const delta = ch && ch.delta || {};
    if(delta.content){
      const b = textBlock();
      sse('content_block_delta',{type:'content_block_delta',index:b.index,delta:{type:'text_delta',text:delta.content}});
    }
    if(Array.isArray(delta.tool_calls)){
      for(const tc of delta.tool_calls){
        const oi = tc.index||0;
        const fn = tc.function||{};
        const b = toolBlock(oi, tc.id, fn.name);
        const partial = fn.arguments||'';
        if(partial){ b.args += partial; sse('content_block_delta',{type:'content_block_delta',index:b.index,delta:{type:'input_json_delta',partial_json:partial}}); }
      }
    }
    if(ch && ch.finish_reason && !stopSent){ stopSent=true; finish(ch.finish_reason); }
  }
  return (async () => {
    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream:true });
      let nl;
      while((nl = buffer.indexOf('\n')) >= 0){
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl+1);
        if(line) onLine(line);
      }
    }
    if(!stopSent){ stopSent=true; finish(); }
    res.end();
  })();
}

function handle(req,res){
  let body='';
  const __t0=Date.now();
  res.on('finish',()=>{ if(res.statusCode!==200){ console.log(req.method+' '+req.url.split('?')[0]+' -> '+res.statusCode+' ('+(Date.now()-__t0)+'ms)'); } });
  req.on('data',c=>body+=c);
  req.on('end',async()=>{
    try{
      const url=req.url.split('?')[0];
      const auth=(req.headers.authorization||req.headers.Authorization||'');
      let token = auth.startsWith('Bearer ')?auth.slice(7):(auth||'');
      if(!token){ token = req.headers['x-api-key']||req.headers['anthropic-api-key']||req.headers['X-API-Key']||''; }
      if(AUTH_TOKEN && token.trim()!==AUTH_TOKEN){ res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'unauthorized'}})); }
      if(req.method==='GET' && (url==='/'||url==='/v1'||url==='/health')){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({status:'ok',env:ENV_ID})); }
      if(req.method==='GET' && (url==='/models'||url==='/v1/models')){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(buildModels())); }
      let payload; try{ payload=JSON.parse(body||'{}'); }catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'bad json'}})); }
      if(url==='/v1/messages/count_tokens'){
        let ct=0; try{ ct=Math.ceil(JSON.stringify(payload.messages||[]).length/4); }catch(e){}
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({input_tokens: ct||1}));
      }
      const isAnthropic = (url==='/v1/messages');
      const reqModel = payload.model || 'hy3';
      if(isAnthropic){ payload = anthropicToOpenAI(payload); }
      else if(payload.model && MODEL_MAP[payload.model]){ payload.model = MODEL_MAP[payload.model]; }
      const stream = !!payload.stream;

      if(stream){
        const streamObj = await callUpstream(payload, true);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
        if(isAnthropic){
          const reader = streamObj.getReader();
          const decoder = new TextDecoder('utf-8');
          streamOpenAIToAnthropic(reader, decoder, res, reqModel).catch(e=>{ if(!res.writableEnded) res.end(); });
        } else {
          const reader = streamObj.getReader();
          const decoder = new TextDecoder('utf-8');
          (async()=>{
            while(true){
              const { done, value } = await reader.read();
              if(done) break;
              res.write(decoder.decode(value, { stream:true }));
            }
            res.end();
          })().catch(()=>res.end());
        }
      } else {
        const r = await callUpstream(payload, false);
        if(isAnthropic){
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(openAIToAnthropic(r, reqModel)));
        } else {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(r));
        }
      }
    }catch(e){
      if(!res.headersSent){
        res.writeHead(502,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}}));
      } else { try{ res.end(); }catch(_){} }
    }
  });
}
const server=http.createServer(handle);
server.listen(PORT, process.env.LISTEN || '127.0.0.1', ()=>console.log('hermes-proxy v5 (env='+ENV_ID+') on '+process.env.LISTEN||'127.0.0.1'+':'+PORT));
