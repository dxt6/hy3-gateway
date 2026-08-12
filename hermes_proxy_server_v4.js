const http = require('http');
const https = require('https');
const tcb = require('@cloudbase/node-sdk');

const ENV_ID = process.env.CB_ENV_ID || '';
const SECRET_ID = process.env.CB_SID || '';
const SECRET_KEY = process.env.CB_SKEY || '';
const AUTH_TOKEN = process.env.CB_PROXY_AUTH || '';
const UA = 'tcb-node-sdk/3.18.3';
const PORT = 8787;
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

let tcbApp = null, cachedToken = null, cachedAt = 0;
function getTcb(){ if(!tcbApp){ tcbApp = tcb.init({env:ENV_ID,timeout:120000,secretId:SECRET_ID,secretKey:SECRET_KEY}); } return tcbApp; }
async function getToken(force){
  const TTL=10*60*1000;
  if(!force && cachedToken && Date.now()-cachedAt<TTL) return cachedToken;
  const c = await getTcb().auth().getClientCredential();
  cachedToken = typeof c==='string'?c:c.access_token; cachedAt=Date.now(); return cachedToken;
}
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

// ---------- 请求转换: Anthropic /v1/messages -> OpenAI chat/completions ----------
function anthToOpenAIMessages(msgs){
  const out = [];
  for(const m of msgs||[]){
    const content = m.content;
    if(Array.isArray(content)){
      if(m.role==='assistant'){
        const text = content.filter(b=>b.type==='text').map(b=>b.text||'').join('');
        const tcs = content.filter(b=>b.type==='tool_use').map(b=>({
          id: anthToolId(b.id),
          type: 'function',
          function: { name: b.name||'', arguments: JSON.stringify(b.input||{}) }
        }));
        if(text || tcs.length){
          const am = { role:'assistant', content: text||null };
          if(tcs.length) am.tool_calls = tcs;
          out.push(am);
        }
      } else { // user: 拆出 tool_result
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
  return out;
}

// ---------- 响应转换: OpenAI -> Anthropic ----------
function openAIToAnthropic(buf, reqModel){
  let j = {}; try{ j = JSON.parse(buf); }catch(e){}
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

// ---------- 流式: OpenAI SSE -> Anthropic SSE (块索引动态分配, 连续且从0开始) ----------
function streamOpenAIToAnthropic(ures, res, reqModel){
  let buffer='', started=false, stopSent=false;
  const blocks = [];          // {index,type:'text'|'tool',id,name,opened,stopped,args}
  let nextIndex = 0;
  const toolByOpenAI = {};    // OpenAI tool_calls index -> block
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
  function closeAll(){
    for(const b of blocks){ if(b.opened && !b.stopped){ sse('content_block_stop',{type:'content_block_stop',index:b.index}); b.stopped=true; } }
  }
  function finish(fr){
    closeAll();
    sse('message_delta',{type:'message_delta',delta:{stop_reason:mapStop(fr),stop_sequence:null},usage:{output_tokens:0}});
    sse('message_stop',{type:'message_stop'});
  }
  ures.on('data',chunk=>{
    buffer += chunk.toString();
    let idx;
    while((idx=buffer.indexOf('\n'))>=0){
      const line = buffer.slice(0,idx); buffer = buffer.slice(idx+1);
      if(!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if(!data || data==='[DONE]'){ if(data==='[DONE]' && !stopSent){ stopSent=true; finish(); } continue; }
      let j; try{ j = JSON.parse(data); }catch(e){ continue; }
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
  });
  ures.on('end',()=>{ if(!stopSent){ stopSent=true; finish(); } res.end(); });
  ures.on('error',()=>{ if(!stopSent){ stopSent=true; finish(); } res.end(); });
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
      const t = await getToken(false);
      const data = JSON.stringify(payload);
      const acceptHdr = stream ? 'text/event-stream' : 'application/json';
      const ureq = https.request(GATEWAY,{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json','User-Agent':UA,'Accept':acceptHdr,'Content-Length':Buffer.byteLength(data)},timeout:280000},(ures)=>{
        if(isAnthropic){
          if(stream){
            if(ures.statusCode!==200){
              let eb=''; ures.on('data',d=>eb+=d); ures.on('end',()=>{
                let msg=(eb||'').slice(0,300);
                try{ const j=JSON.parse(eb); msg=j.message||j.code||msg; }catch(e){}
                res.writeHead(ures.statusCode||500,{'Content-Type':'application/json'});
                res.end(JSON.stringify({error:{message:'upstream '+msg}}));
              });
              return;
            }
            res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
            streamOpenAIToAnthropic(ures, res, reqModel);
          } else {
            let buf=''; ures.on('data',d=>buf+=d); ures.on('end',()=>{
              const ok = ures.statusCode>=200 && ures.statusCode<300;
              if(!ok){
                let msg=(buf||'').slice(0,300);
                try{ const j=JSON.parse(buf); msg=j.message||j.code||msg; }catch(e){}
                res.writeHead(ures.statusCode||500,{'Content-Type':'application/json'});
                return res.end(JSON.stringify({error:{message:'upstream '+msg}}));
              }
              res.writeHead(200,{'Content-Type':'application/json'});
              res.end(JSON.stringify(openAIToAnthropic(buf, reqModel)));
            });
          }
        } else {
          if(stream){
            if(ures.statusCode!==200){
              let eb=''; ures.on('data',d=>eb+=d); ures.on('end',()=>{
                let msg=(eb||'').slice(0,300);
                try{ const j=JSON.parse(eb); msg=j.message||j.code||msg; }catch(e){}
                res.writeHead(ures.statusCode||500,{'Content-Type':'application/json'});
                res.end(JSON.stringify({error:{message:'upstream '+msg}}));
              });
              return;
            }
            res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
            ures.on('data',d=>res.write(d));
            ures.on('end',()=>res.end());
            ures.on('error',()=>res.end());
          } else {
            let buf=''; ures.on('data',d=>buf+=d); ures.on('end',()=>{
              const ok = ures.statusCode>=200 && ures.statusCode<300;
              let out = buf;
              if(!ok){
                let msg=(buf||'').slice(0,300);
                try{ const j=JSON.parse(buf); msg=j.message||j.code||msg; }catch(e){}
                out = JSON.stringify({error:{message:'upstream '+msg}});
              }
              res.writeHead(ok?200:(ures.statusCode||500),{'Content-Type':'application/json'});
              res.end(out);
            });
          }
        }
      });
      ureq.on('error',e=>{ if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}else{res.end();} });
      ureq.on('timeout',()=>ureq.destroy(new Error('gateway timeout')));
      ureq.write(data); ureq.end();
    }catch(e){
      if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}
    }
  });
}
const server=http.createServer(handle);
server.listen(PORT,'127.0.0.1',()=>console.log('hermes-proxy v4.1 (env='+ENV_ID+') on 127.0.0.1:'+PORT));
