const http = require('http');
const zlib = require('zlib');
const tcb = require('@cloudbase/node-sdk');

const ENV_ID = process.env.CB_ENV_ID || '';
const SECRET_ID = process.env.CB_SID || '';
const SECRET_KEY = process.env.CB_SKEY || '';
const AUTH_TOKEN = process.env.CB_PROXY_AUTH || '';
const PORT = 8787;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
const GATEWAY = 'https://' + ENV_ID + '.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions';

// CloudBase 成长计划只认内置模型；把常见 Claude/OpenAI 模型名映射到 hy3-preview（用户指定，开启 hy3-preview 提速）
const MODEL_MAP = {
  'claude-haiku-4-5':'hy3-preview','claude-sonnet-4-5':'hy3-preview','claude-opus-4-1':'hy3-preview',
  'claude-3-5-sonnet':'hy3-preview','claude-3-5-haiku':'hy3-preview','claude-3-sonnet':'hy3-preview',
  'claude-3-haiku':'hy3-preview','claude-3-opus':'hy3-preview','claude-2.1':'hy3-preview','claude-2.0':'hy3-preview',
  'claude-instant-1.2':'hy3-preview','claude-instant-1':'hy3-preview',
  'gpt-4o':'hy3-preview','gpt-4o-mini':'hy3-preview','gpt-4-turbo':'hy3-preview','gpt-4':'hy3-preview','gpt-3.5-turbo':'hy3-preview',
  'deepseek-chat':'hy3-preview','deepseek-reasoner':'hy3-preview',
  'qwen-plus':'hy3-preview','qwen-turbo':'hy3-preview','qwen-max':'hy3-preview',
  'glm-4':'hy3-preview','glm-4-plus':'hy3-preview','kimi':'hy3-preview','moonshot-v1-8k':'hy3-preview'
};
const BASE_MODELS = ['hy3-preview','deepseek-v4-flash','qwen3.5-flash','glm-5.2','kimi-k2.6','minimax-m3'];

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
  const out = { model: MODEL_MAP[p.model]||p.model||'hy3-preview', max_tokens: p.max_tokens||1024 };
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

// ---------- 上下文保护（保守策略：默认 100% 保留，仅极端情况才动） ----------
const HARD_CTX_EST = 250000;   // 极端安全阀：仅当估算 > 250K 才考虑删最旧轮次
const SINGLE_TOOL_MAX = 32000; // 单条 tool_result 安全字符上限（远宽松于原 2000）
function trimContext(payload){
  const msgs = payload.messages;
  if(!Array.isArray(msgs) || !msgs.length) return;
  const est = () => Math.ceil(JSON.stringify(msgs).length / 3);
  // 始终先做单条级压缩（只压超长 tool_result，不影响整体上下文）
  compressBigToolResults(msgs);
  // 极端安全阀：仅在远超窗口时，从头部成对删除最旧轮次，并打告警日志
  if(est() > HARD_CTX_EST){
    let i = 0, removed = 0;
    while(msgs.length > 4 && est() > HARD_CTX_EST && i < msgs.length - 2){
      msgs.splice(i, 2); removed += 2;
    }
    console.log('[hermes][WARN] context OVERSAFE-TRIM removed '+removed+' oldest msgs, now '+msgs.length+' msgs, est '+est()+' tok');
  }
  // 正常会话（≤ 250K）完全不改动 messages，上下文 100% 保留
}
function compressBigToolResults(msgs){
  for(const m of msgs){
    const c = m.content;
    if(Array.isArray(c)){
      for(const b of c){
        if(b && b.type==='tool_result' && typeof b.content==='string' && b.content.length>SINGLE_TOOL_MAX){
          // 只截断单条超长工具结果，避免上游单条溢出；其余上下文不动
          b.content = b.content.slice(0, SINGLE_TOOL_MAX) + String.fromCharCode(10) + '...[gateway: tool_result truncated to '+SINGLE_TOOL_MAX+' chars]';
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

// 兼容客户端以 HTTP 代理方式把整条 HTTP 请求塞进 body（请求体以 "POST http://... HTTP/1.1" 开头）
function extractJSONBody(s){
  if(!s) return s;
  const t = s.trim();
  if(t[0]==='{' || t[0]==='[') return t;
  const m = t.match(/^(?:POST|GET|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d\.\d\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/);
  if(m) return m[1].trim();
  return t;
}

// ---------- OpenAI Responses API 兼容层（供 codex 等走 /responses 的客户端） ----------
function responsesToChat( body ){
  const b = body || {};
  const out = {
    model: MODEL_MAP[b.model] || 'hy3-preview',
    messages: [],
    stream: !!b.stream
  };
  if(b.max_output_tokens || b.max_tokens) out.max_tokens = parseInt(b.max_output_tokens || b.max_tokens, 10);
  if(b.temperature !== undefined) out.temperature = b.temperature;
  if(b.top_p !== undefined) out.top_p = b.top_p;
  const normTool = (t)=>{ const f = t.function || t; return { type:'function', function:{ name:f.name||'', description:f.description||'', parameters:f.parameters||f.input_schema||{type:'object',properties:{}} } }; };
  const input = b.input;
  const customTools = []; // additional_tools 里的 non-function 工具（如 codex 的 custom exec），网关/上游无法真执行，降级为系统消息
  const pushText = (role, text)=>{ if(text) out.messages.push({ role, content: text }); };
  const pushImgs = (role, imgs)=>{
    if(!imgs.length) return;
    const last = out.messages[out.messages.length-1];
    if(last && Array.isArray(last.content)){ for(const u of imgs){ last.content.push({ type:'image_url', image_url:{ url:u } }); } }
    else { const cm=[{type:'text',text:''}]; for(const u of imgs){ cm.push({type:'image_url',image_url:{url:u}}); } out.messages.push({ role, content: cm }); }
  };
  if(typeof input === 'string'){
    pushText('user', input);
  } else if(Array.isArray(input)){
    for(const it of input){
      if(typeof it === 'string'){ pushText('user', it); continue; }
      if(!it || typeof it !== 'object') continue;
      // ---- Responses API 内置工具：additional_tools（developer role 的 custom/function 工具，codex 用）----
      if(it.type==='additional_tools' && Array.isArray(it.tools)){
        for(const t of it.tools){
          if(t.type==='function' || t.function){ if(!out.tools) out.tools=[]; out.tools.push(normTool(t)); }
          else { customTools.push({ name:t.name, description:t.description, parameters: t.parameters||t.input_schema }); }
        }
        continue;
      }
      let role = (it.role==='system'||it.role==='developer')?'system':((it.role==='assistant')?'assistant':'user');
      let content = it.content;
      if(it.type==='input_text' && it.text){ pushText(role, it.text); continue; }
      if(Array.isArray(content)){
        const txt = content.filter(x=>x&&(x.type==='input_text'||x.type==='text')).map(x=>x.text||'').join('');
        const imgs = content.filter(x=>x&&(x.type==='input_image'||x.type==='image_url')).map(x=>x.image_url||x.image||'').filter(Boolean);
        if(txt) pushText(role, txt);
        pushImgs(role, imgs);
      } else if(typeof content === 'string'){
        pushText(role, content);
      }
    }
  }
  // 顶层 function 工具（标准 Responses API tools 字段）
  if(Array.isArray(b.tools)){
    if(!out.tools) out.tools=[];
    for(const t of b.tools){ if(t&&(t.type==='function'||t.function)) out.tools.push(normTool(t)); }
  }
  // 把所有 custom 工具降级成一条系统消息，让模型“知道”有这能力（hy3 不支持真执行）
  if(customTools.length){
    const desc = customTools.map(c=>'- '+(c.name||'?')+(c.description?': '+c.description:'')).join(String.fromCharCode(10));
    out.messages.unshift({ role:'system', content:'[gateway] 客户端声明了以下 custom 工具（当前网关无法真实执行，请用自然语言说明意图即可）：'+String.fromCharCode(10)+desc });
  }
  // tool_choice 守卫：仅当确有可用 function 工具时才保留；否则上游 chat/completions 会报 “tools is required when tool_choice is set” -> 502
  if(b.tool_choice){
    const tc = b.tool_choice;
    const hasTools = Array.isArray(out.tools) && out.tools.length>0;
    if((tc==='auto'||tc==='none') && hasTools) out.tool_choice = tc;
    else if(tc.type==='function'){ if(hasTools) out.tool_choice = { type:'function', function:{ name: tc.name } }; }
    else if(tc==='required'){ if(hasTools) out.tool_choice = 'required'; else delete out.tool_choice; }
    else if(hasTools) out.tool_choice = tc;
    else delete out.tool_choice;
  }
  trimContext(out);
  return out;
}



function chatToResponses( j, reqModel ){
  const ch = j.choices && j.choices[0];
  const msg = ch && ch.message || {};
  const output = [];
  if(msg.content) output.push({ type:'message', status:'completed', role:'assistant', content:[{ type:'output_text', text: msg.content, annotations:[] }] });
  if(Array.isArray(msg.tool_calls)){
    for(const tc of msg.tool_calls){
      let args = tc.function.arguments;
      try{ args = JSON.parse(args||'{}'); }catch(e){ try{ args = JSON.parse(args); }catch(_){} }
      output.push({ type:'function_call', status:'completed', name: tc.function.name||'', arguments: args, call_id: (tc.id||('call_'+Math.random().toString(36).slice(2,12))) });
    }
  }
  return {
    id: 'resp_' + (j.id||('r_'+Date.now())),
    object: 'response',
    created_at: Math.floor(Date.now()/1000),
    model: reqModel,
    output: output,
    usage: j.usage ? { input_tokens: j.usage.prompt_tokens||0, output_tokens: j.usage.completion_tokens||0, total_tokens: j.usage.total_tokens||0 } : null,
    status: 'completed'
  };
}

// 注意：本函数由主 handler 在已经读完请求体之后调用，bodyStr 是已解码的请求体字符串，
// 不要再对 req 注册 data/end 监听（那些事件早已触发），否则会永久挂起。
async function handleResponses( res, authOk, bodyStr ){
  if(!authOk){ res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'unauthorized'}})); }
  let payload;
  try{ payload = JSON.parse(bodyStr||'{}'); }
  catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'bad json'}})); }
  const chat = responsesToChat(payload);
  const reqModel = chat.model;
  console.log('[responses] IN model='+(payload&&payload.model)+' stream='+(!!(payload&&payload.stream))+' nMsgs='+(Array.isArray(payload&&payload.input)?payload.input.length:0));
  try{
    if(chat.stream){
      const streamObj = await callUpstream(chat, true);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
      const reader = streamObj.getReader(); const decoder = new TextDecoder('utf-8');
      let buf=''; let text='';
      const push = (evt, data)=>{ res.write('event: '+evt+'\n'); res.write('data: '+JSON.stringify(data)+'\n\n'); };
      const rid = 'resp_'+Date.now();
      const iid = 'msg_'+rid, pid = 'part_'+rid;
      push('response.created', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
      push('response.in_progress', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
      push('response.output_item.added', { output_index:0, item:{ id:iid, type:'message', status:'in_progress', role:'assistant', content:[] } });
      push('response.content_part.added', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text:'', annotations:[] } });
      (async()=>{
        try{
          while(true){
            const { done, value } = await reader.read();
            if(done) break;
            buf += decoder.decode(value,{stream:true});
            const parts = buf.split('\n'); buf = parts.pop();
            for(const line of parts){
              const s = line.trim();
              if(!s.startsWith('data:')) continue;
              const d = s.slice(5).trim();
              if(d==='[DONE]') continue;
              let j; try{ j = JSON.parse(d); }catch(e){ continue; }
              const dc = j.choices && j.choices[0] && j.choices[0].delta;
              if(dc && dc.content){ text += dc.content; push('response.output_text.delta', { item_id:iid, output_index:0, content_index:0, delta: dc.content }); }
            }
          }
          const outText = text || '';
          push('response.content_part.done', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text: outText, annotations:[] } });
          push('response.output_item.done', { output_index:0, item:{ id:iid, type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] } });
          push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: outText, annotations:[]}]}], usage:null });
          res.end();
        }catch(e){
          console.error('[responses][stream] FAIL err='+((e&&e.message)||String(e))+' model='+reqModel);
          if(!res.writableEnded){
            const outText = text || '';
            push('response.content_part.done', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text: outText, annotations:[] } });
            push('response.output_item.done', { output_index:0, item:{ id:iid, type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] } });
            push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: outText, annotations:[]}]}], usage:null });
            res.end();
          }
        }
      })();
    } else {
      const r = await callUpstream(chat, false);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(chatToResponses(r, reqModel)));
    }
  }catch(e){
    if(!res.headersSent){ res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}})); }
    else if(!res.writableEnded) res.end();
  }
}

function handle(req,res){
  const chunks=[];
  const __t0=Date.now();
  res.on('finish',()=>{ if(res.statusCode!==200){ console.log(req.method+' '+req.url.split('?')[0]+' -> '+res.statusCode+' ('+(Date.now()-__t0)+'ms)'); } });
  req.on('data',c=>chunks.push(c));
  req.on('end',async()=>{
    const rawBody = Buffer.concat(chunks);
    const ce = (req.headers['content-encoding']||'').toLowerCase();
    let body;
    try{
      if(ce.includes('gzip')) body = zlib.gunzipSync(rawBody).toString('utf-8');
      else if(ce.includes('deflate')) body = zlib.inflateSync(rawBody).toString('utf-8');
      else body = rawBody.toString('utf-8');
    }catch(e){ body = rawBody.toString('utf-8'); }
    try{
      let url=req.url.split('?')[0];
      if(/^https?:\/\//i.test(url)){ try{ url=new URL(url).pathname; }catch(e){} }
      const auth=(req.headers.authorization||req.headers.Authorization||'');
      let token = auth.startsWith('Bearer ')?auth.slice(7):(auth||'');
      if(!token){ token = req.headers['x-api-key']||req.headers['anthropic-api-key']||req.headers['X-API-Key']||''; }
      if(AUTH_TOKEN && token.trim()!==AUTH_TOKEN){ res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'unauthorized'}})); }
            if(url==='/responses' || url==='/v1/responses'){ return handleResponses(res, (AUTH_TOKEN? (token.trim()===AUTH_TOKEN):true), body); }
if(req.method==='GET' && (url==='/'||url==='/v1'||url==='/health')){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({status:'ok',env:ENV_ID})); }
      if(req.method==='GET' && (url==='/models'||url==='/v1/models')){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(buildModels())); }
      let payload; try{ payload=JSON.parse(extractJSONBody(body)||'{}'); }catch(e){
        const fs=require('fs'); const raw=Buffer.concat(chunks);
        const info='['+new Date().toISOString()+'] ce='+(req.headers['content-encoding']||'none')+' ct='+(req.headers['content-type']||'none')+' len='+raw.length+' first128hex='+raw.slice(0,128).toString('hex')+'\n';
        try{ fs.appendFileSync('/tmp/hermes_badreq.log', info+'B64:'+raw.toString('base64')+'\n\n'); }catch(_){}
        res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'bad json'}}));
      }
      if(url==='/v1/messages/count_tokens'){
        let ct=0; try{ ct=Math.ceil(JSON.stringify(payload.messages||[]).length/4); }catch(e){}
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({input_tokens: ct||1}));
      }
      const isAnthropic = (url==='/v1/messages');
      const reqModel = payload.model || 'hy3-preview';
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
