const http = require('http');
const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const { Readable } = require('stream');
const tcb = require('@cloudbase/node-sdk');
const WebSocket = require('ws');

const ENV_ID = process.env.CB_ENV_ID || '';
const SECRET_ID = process.env.CB_SID || '';
const SECRET_KEY = process.env.CB_SKEY || '';
const AUTH_TOKEN = process.env.CB_PROXY_AUTH || '';
const PORT = 8787;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
const GATEWAY = 'https://' + ENV_ID + '.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions';

// ---------- 视觉能力（Vision）配置：请求带图片时路由到支持视觉的 OpenAI 兼容 API ----------
// 检测到消息含 image_url 内容块 → 自动改走 VISION_BASE_URL（默认智谱 GLM-4V-Flash，免费）；
// 纯文本请求 100% 继续走 CloudBase hy3（不消耗额外额度）。不配 VISION_API_KEY 则视觉路由自动关闭。
const VISION_BASE_URL = process.env.VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const VISION_API_KEY = process.env.VISION_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4v-flash';

// CloudBase 成长计划只认内置模型；把常见 Claude/OpenAI 模型名映射到 hy3（用户指定改用 hy3）
const MODEL_MAP = {
  'claude-haiku-4-5':'hy3','claude-sonnet-4-5':'hy3','claude-opus-4-1':'hy3',
  'claude-3-5-sonnet':'hy3','claude-3-5-haiku':'hy3','claude-3-sonnet':'hy3',
  'claude-3-haiku':'hy3','claude-3-opus':'hy3','claude-2.1':'hy3','claude-2.0':'hy3',
  'claude-instant-1.2':'hy3','claude-instant-1':'hy3',
  'gpt-4o':'hy3','gpt-4o-mini':'hy3','gpt-4-turbo':'hy3','gpt-4':'hy3','gpt-3.5-turbo':'hy3',
  'deepseek-chat':'hy3','deepseek-reasoner':'hy3',
  'qwen-plus':'hy3','qwen-turbo':'hy3','qwen-max':'hy3',
  'glm-4':'hy3','glm-4-plus':'hy3','kimi':'hy3','moonshot-v1-8k':'hy3'
};
const BASE_MODELS = ['hy3','deepseek-v4-flash','qwen3.5-flash','glm-5.2','kimi-k2.6','minimax-m3'];

function buildModels(){
  const set = new Set(BASE_MODELS.concat(Object.keys(MODEL_MAP)));
  if(VISION_API_KEY && VISION_MODEL) set.add(VISION_MODEL); // 视觉模型仅在配了 key 时暴露
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
// 判断是否为可重试的「上游瞬时错误」（网络/网关层 5xx + 上游 JSON-RPC 内部错误）。
// 注意：不重试 4xx / 参数错误（那是请求本身有问题，重试无用）。
// 上游错误：携带真实 HTTP 状态码，让 handler 透传给客户端（而非一律 502）。
class UpstreamError extends Error {
  constructor(status, message){ super(message); this.name='UpstreamError'; this.status = status; this.upstream = true; }
}

// 判断是否为可重试的「上游瞬时错误」。
// 优先用显式 HTTP 状态码（从异常消息解析，如 "Request failed with status code 400"）做分类，
// 再回退到关键词启发式。该 CloudBase 后端的 400/5xx 多为瞬时抖动（实测同请求稍后 curl 即 200），
// 应进重试；而 401/403/404/422 等是鉴权/请求问题，重试无用，原样透传真实状态码。
function isTransientUpstreamError(o, status){
  if(typeof status === 'number' && status >= 400){
    if([500,502,503,504,507,508, 408,409,425,429, 400].includes(status)) return true; // 400 在本后端多为瞬时
    if([401,403,404,405,410,411,412,413,414,415,416,422,423,424].includes(status)) return false; // 鉴权/定位/参数类不重试
    return false; // 其他 4xx 默认不重试
  }
  const s = (typeof o === 'string') ? o : JSON.stringify(o || '');
  if(/429|rate|jar|limit|quota|过于频繁|超出并发|too many|exceed|502|500|503|504|network error|ECONN|ETIMEDOUT|ECONNRESET|socket hang|bad gateway|gateway timeout|internal error|-32603|-32001/i.test(s)) return true;
  if(/404|400|401|403|invalid|unsupported|required|too long|bad request/i.test(s)) return false; // 明确的请求/参数错误，不重试
  // 上游 JSON-RPC / OpenAI 错误体里的瞬时类
  const code = (typeof o === 'object' && o) ? (o.code ?? (o.error && o.error.code)) : undefined;
  const cat = (typeof o === 'object' && o) ? ((o.category) || (o.error && o.error.category) || (o.data && o.data.category)) : undefined;
  if(code === -32603 || code === -32001 || code === -32000) return true; // 上游内部/网络错误
  if(cat === 'internal' || cat === 'network' || cat === 'rate_limit') return true;
  return false;
}

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
      // 上游有时返回 HTTP 200 + 错误体（如 JSON-RPC {code:-32603,message:"Internal error"}），
      // 这种不算成功，需当作失败重试；但明确的请求/参数错误则原样透传给客户端。
      if(res && (res.error || (typeof res.code === 'number' && res.code < 0))){
        const errStr = JSON.stringify(res).slice(0,200);
        console.log('[hermes][UPSTREAM-ERR] ' + errStr);
        if(isTransientUpstreamError(res) && attempt < maxRetries){
          attempt++;
          const backoff = Math.min(1000 * 2 ** attempt, 8000);
          console.log('[hermes] retry '+attempt+'/'+maxRetries+' (upstream error body) after '+backoff+'ms');
          await new Promise(r=>setTimeout(r, backoff));
          continue;
        }
        return res; // 不可重试的错误体：原样透传，由客户端（codex）展示
      }
      return res;
    }catch(e){
      release();
      const msg = (e && e.message) || String(e);
      const m = msg.match(/status code (\d{3})/i);
      const status = m ? parseInt(m[1],10) : 0;
      console.log('[hermes][UPSTREAM-EXC] ' + msg.slice(0,200) + (status? ' [http '+status+']':''));
      if(isTransientUpstreamError(msg, status) && attempt < maxRetries){
        attempt++;
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        console.log('[hermes] retry '+attempt+'/'+maxRetries+' (upstream '+(status||'?')+') after '+backoff+'ms');
        await new Promise(r=>setTimeout(r, backoff));
        continue;
      }
      // 非瞬时或重试耗尽：把真实上游状态/错误回给客户端，不再包成笼统 502（避免 codex 误判网络错误重试）
      const outStatus = (status>=400) ? status : 502;
      throw new UpstreamError(outStatus, msg);
    }
  }
}

// ---------- 视觉路由：检测消息里是否含图片（image_url 内容块） ----------
// 所有输入（Responses input_image / Anthropic image 块 / 原生 OpenAI image_url）转换后统一
// 变成 OpenAI 的 {type:'image_url'} 块，检测这个即可。返回 true 表示该请求需要视觉模型。
function hasVision(messages){
  for(const m of messages||[]){
    const c = m && m.content;
    if(Array.isArray(c)){
      for(const b of c){ if(b && b.type==='image_url') return true; }
    }
  }
  return false;
}
// Anthropic image 块 → OpenAI image_url 块（base64 或 url 两种 source 都支持）
function anthImageToOpenAI(b){
  const src = b && b.source;
  if(!src) return null;
  if(src.type==='base64' && src.data){
    return { type:'image_url', image_url:{ url: 'data:'+(src.media_type||'image/png')+';base64,'+src.data } };
  }
  if(src.type==='url' && src.url){
    return { type:'image_url', image_url:{ url: src.url } };
  }
  return null;
}

// ---------- 视觉上游调用：HTTP 直连 OpenAI 兼容 API（智谱 GLM-4V-Flash 等） ----------
// 与 CloudBase 的 callUpstream 返回形态完全一致：非流式返回 JSON、流式返回带 getReader() 的流，
// 因此上层所有 SSE→Responses/Anthropic 转换代码无需任何改动即可复用。
function callVisionUpstream(payload, stream){
  return new Promise((resolve, reject)=>{
    let u;
    try{ u = new URL(VISION_BASE_URL); }
    catch(e){ return reject(new UpstreamError(502, 'bad VISION_BASE_URL: '+VISION_BASE_URL)); }
    const body = JSON.stringify(payload);
    const mod = u.protocol==='http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol==='https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization':'Bearer ' + VISION_API_KEY,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':'hermes-proxy-v5/vision',
        'Accept':'text/event-stream'
      },
      timeout: 280000
    }, (up)=>{
      if(stream){
        if(up.statusCode !== 200){
          let errBuf='';
          up.on('data', c=>errBuf+=c);
          up.on('end', ()=>reject(new UpstreamError(up.statusCode||502, 'vision upstream HTTP '+up.statusCode+': '+errBuf.slice(0,200))));
          return;
        }
        resolve(Readable.toWeb(up)); // web ReadableStream，兼容现有 getReader() 用法
      } else {
        let buf='';
        up.on('data', c=>buf+=c);
        up.on('end', ()=>{
          if(up.statusCode !== 200){
            return reject(new UpstreamError(up.statusCode||502, 'vision upstream HTTP '+up.statusCode+': '+buf.slice(0,200)));
          }
          try{ resolve(JSON.parse(buf)); }
          catch(e){ reject(new Error('vision upstream bad json: '+buf.slice(0,200))); }
        });
      }
    });
    req.on('error', e=>reject(new UpstreamError(502, 'vision upstream error: '+e.message)));
    req.on('timeout', ()=>{ req.destroy(new Error('vision upstream timeout')); });
    req.write(body); req.end();
  });
}
// 视觉上游简单重试（瞬时 5xx/超时/429 退避 1s/2s；参数类 4xx 不重试）
async function callVisionWithRetry(payload, stream){
  const maxRetries = 2;
  let attempt = 0;
  while(true){
    try{
      return await callVisionUpstream(payload, stream);
    }catch(e){
      const st = (e && e.status) ? e.status : 0;
      const transient = st===0 || [500,502,503,504,507,508,408,409,425,429].includes(st);
      if(transient && attempt < maxRetries){
        attempt++;
        const backoff = 1000 * attempt;
        console.log('[vision] retry '+attempt+'/'+maxRetries+' (http '+(st||'?')+') after '+backoff+'ms');
        await new Promise(r=>setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
}

// ---------- 智能上游分发：带图片 → 视觉 API；纯文本 → CloudBase hy3 ----------
async function callUpstreamSmart(payload, stream){
  if(payload && payload.__vision && VISION_API_KEY){
    payload.model = VISION_MODEL; // 视觉请求强制使用视觉模型名
    console.log('[vision] ROUTE model='+VISION_MODEL+' stream='+!!stream+' msgs='+(payload.messages||[]).length);
    return callVisionWithRetry(payload, stream);
  }
  return callUpstream(payload, stream);
}


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
        const images = content.filter(b=>b.type==='image').map(anthImageToOpenAI).filter(Boolean);
        if(text || images.length){
          // 有图片时 content 必须是数组（text + image_url 混合）；纯文本保持字符串形态（避免改变非视觉请求行为）
          const cm = [];
          if(text) cm.push({ type:'text', text });
          for(const img of images) cm.push(img);
          const onlyText = cm.length===1 && cm[0].type==='text';
          out.push({ role:'user', content: onlyText ? text : cm });
        }
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
  out.__vision = hasVision(out.messages); // 视觉标记：含图片 → callUpstreamSmart 路由到视觉上游
  return out;
}

// ---------- 上下文保护（软上限：避免长上下文把上游 hy3 拖慢到客户端超时） ----------
// MAX_CTX_TOKENS：软上限（token 估算，约 1 token ≈ 3 字符）。超过则从头部成对删除最旧轮次，
// 并由 compressBigToolResults 截断单条超长 tool_result。env 设为 0 可完全关闭裁剪（旧行为：100% 保留）。
// 实测：hy3 上游对 >100K token 的输入响应需 1–2 分钟且偶发 500，客户端易超时 → 故默认压到 64K。
const MAX_CTX_TOKENS = (()=>{ const v = parseInt(process.env.MAX_CTX_TOKENS, 10); return Number.isFinite(v) ? v : 64000; })();
const SINGLE_TOOL_MAX = 32000; // 单条 tool_result 安全字符上限
const SINGLE_MSG_MAX = 60000;  // 单条普通 user/assistant 文本安全字符上限
function trimContext(payload){
  const msgs = payload.messages;
  if(!Array.isArray(msgs) || !msgs.length) return;
  if(MAX_CTX_TOKENS <= 0) return; // 显式关闭裁剪
  const est = () => Math.ceil(JSON.stringify(msgs).length / 3);
  compressBigToolResults(msgs);
  if(est() <= MAX_CTX_TOKENS) return; // 未超限，100% 保留
  // 超过软上限：从头部成对删除最旧轮次（保留首条 system/developer 与最近轮）
  let removed = 0, i = 0;
  if(msgs[0] && (msgs[0].role==='system'||msgs[0].role==='developer')) i = 1;
  while(msgs.length > 4 && est() > MAX_CTX_TOKENS && i < msgs.length - 2){
    msgs.splice(i, 2); removed += 2;
  }
  // 若仍能删不动但整体仍超长（单条巨型文本），截断最长单条文本消息
  if(est() > MAX_CTX_TOKENS){
    for(const m of msgs){
      const c = m.content;
      if(typeof c === 'string' && c.length > SINGLE_MSG_MAX){
        m.content = c.slice(0, SINGLE_MSG_MAX) + '\n...[gateway: message truncated to '+SINGLE_MSG_MAX+' chars]';
        removed++;
      } else if(Array.isArray(c)){
        for(const b of c){ if(b && typeof b.text==='string' && b.text.length>SINGLE_MSG_MAX){ b.text = b.text.slice(0,SINGLE_MSG_MAX)+'\n...[gateway: truncated]'; } }
      }
    }
  }
  console.log('[hermes][WARN] context TRIM removed/truncated '+removed+' items, now '+msgs.length+' msgs, est '+est()+' tok (limit '+MAX_CTX_TOKENS+')');
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
    model: MODEL_MAP[b.model] || 'hy3',
    messages: [],
    stream: !!b.stream
  };
  if(b.max_output_tokens || b.max_tokens) out.max_tokens = parseInt(b.max_output_tokens || b.max_tokens, 10);
  if(b.temperature !== undefined) out.temperature = b.temperature;
  if(b.top_p !== undefined) out.top_p = b.top_p;
  const normTool = (t)=>{ const f = t.function || t; return { type:'function', function:{ name:f.name||'', description:f.description||'', parameters:f.parameters||f.input_schema||{type:'object',properties:{}} } }; };
  const input = b.input;
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
          else {
            // 把 custom 工具（如 codex 的 exec）也暴露为 function 工具，让上游能正式发起 tool_call；
            // 网关只转发 tool_call，实际执行在客户端（codex 本地 V8）。description 必须完整传给上游——
            // exec 的正确用法（text() 输出 / tools.exec_command() 嵌套 / 无 console 无网络）都在描述里，截断会导致模型写错代码
            if(!out.tools) out.tools=[];
            out.tools.push({ type:'function', function:{ name: t.name||('custom_'+((out.tools||[]).length+1)), description: t.description||'', parameters: t.input_schema||t.parameters||{ type:'object', properties:{ code:{ type:'string', description:'JavaScript source code to evaluate' } }, required:['code'] } } });
          }
        }
        continue;
      }
      // ---- 多轮工具结果：function_call/custom_tool_call（assistant 发起的工具调用）与 *_output（工具返回）----
      if(it.type==='function_call' || it.type==='custom_tool_call'){
        // 上游 hy3 要求 tool_calls[].arguments 是 JSON 对象（会 json.loads(...).items()）：
        // custom 工具的原始 input 字符串要包成 {code: ...} 对象，function 工具的 arguments 保持原样
        const args = it.type==='custom_tool_call'
          ? (typeof it.input==='string' ? JSON.stringify({code: it.input}) : JSON.stringify(it.input||{}))
          : (typeof it.arguments==='string' ? it.arguments : JSON.stringify(it.arguments||{}));
        const cid = it.call_id || ('call_'+Math.random().toString(36).slice(2,12));
        out.messages.push({ role:'assistant', content:null, tool_calls:[{ id:cid, type:'function', function:{ name: it.name||'', arguments: args } }] });
        continue;
      }
      if(it.type==='function_call_output' || it.type==='custom_tool_call_output'){
        const c = typeof it.output==='string' ? it.output : JSON.stringify(it.output||'');
        out.messages.push({ role:'tool', tool_call_id: it.call_id||'', content: c });
        continue;
      }
      let role = (it.role==='system'||it.role==='developer')?'system':((it.role==='assistant')?'assistant':'user');
      let content = it.content;
      if(it.type==='input_text' && it.text){ pushText(role, it.text); continue; }
      // ---- 顶层图片（OpenAI Responses 规范 / codex 实际发送格式）：{"type":"input_image","image_url":"data:..."} ----
      // 原实现只认 content 数组内的图片，顶层 input_image 会被静默丢弃 → 视觉请求永远到不了视觉上游
      if((it.type==='input_image' || it.type==='image') && (it.image_url || it.image)){
        pushImgs(role, [it.image_url || it.image]);
        continue;
      }
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
  out.__vision = hasVision(out.messages); // 视觉标记：含图片 → callUpstreamSmart 路由到视觉上游
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
  // custom 工具名单（由网关暴露为 function 工具）：codex 的 exec 要求参数是原始 JS 字符串而非 JSON 对象，
  // 转发 tool_call 时对 {code:...}/{string:...} 单键对象解包
  const customNames = new Set();
  for(const it of (Array.isArray(payload&&payload.input)?payload.input:[])){
    if(it && it.type==='additional_tools' && Array.isArray(it.tools)){
      for(const t of it.tools){ if(t && t.type!=='function' && !t.function && t.name) customNames.add(t.name); }
    }
  }
  const unwrapArgs = (name, argsStr)=>{
    if(!customNames.has(name)) return argsStr;
    // codex 的 custom 工具（exec）把 arguments 当原始输入：JSON 字符串要解引号、{code}/{string} 单键对象要取内层值
    try{
      const p = JSON.parse(argsStr);
      if(typeof p === 'string') return p;
      if(p && typeof p==='object' && !Array.isArray(p)){
        const ks = Object.keys(p);
        if(ks.length===1 && (ks[0]==='code'||ks[0]==='string')) return String(p[ks[0]]);
      }
    }catch(_){}
    return argsStr;
  };
  const toolDefs = JSON.stringify((Array.isArray(payload&&payload.input)?payload.input:[]).filter(it=>it&&it.type==='additional_tools'&&Array.isArray(it.tools)).map(it=>it.tools.map(t=>({type:t&&t.type,name:t&&t.name,schema:t&&(t.input_schema||t.parameters)||null})))).slice(0,2000);
  console.log('[responses] TOOLDEFS '+toolDefs);
  console.log('[responses] CHAT model='+chat.model+' tools='+((chat.tools||[]).length)+' tc='+JSON.stringify(chat.tool_choice||null)+' mt='+(chat.max_tokens||'-')+' msgs='+(chat.messages||[]).length+' stream='+!!chat.stream);
  console.log('[responses] IN model='+(payload&&payload.model)+' stream='+(!!(payload&&payload.stream))+' nMsgs='+(Array.isArray(payload&&payload.input)?payload.input.length:0)+' body='+JSON.stringify(payload).slice(0,4000));
  try{
    if(chat.stream){
      // 立即发响应头 + 保活：上游 prefill 期间（codex 长上下文可达数十秒）客户端若一直收不到字节，会被 Cloudflare/客户端 idle 超时掐断 -> "stream closed before response.completed"
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
      const decoder = new TextDecoder('utf-8');
      let buf=''; let text=''; let deltaCount=0; let toolCalls={};
      const push = (evt, data)=>{ const d = Object.assign({}, data, { type: evt }); res.write('event: '+evt+'\n'); res.write('data: '+JSON.stringify(d)+'\n\n'); };
      const rid = 'resp_'+Date.now();
      const iid = 'msg_'+rid, pid = 'part_'+rid;
      // 心跳：从 prefill 期就开始保活，整个流生命周期内每 3s 一条 SSE 注释（客户端/CF 忽略注释但重置 idle 计时）；仅在流收尾时清除
      let hbCleared = false;
      const clearHb = ()=>{ if(!hbCleared){ hbCleared=true; try{ clearInterval(heartbeat); }catch(_){} } };
      const heartbeat = setInterval(()=>{ try{ res.write(': ping\n\n'); }catch(_){} }, 3000);
      res.write(': ping\n\n'); // 抢在 prefill 之前先发一字节，让连接立刻变活跃
      // 先发标准开场事件，让客户端确认流已开始
      push('response.created', { response: { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] } });
      push('response.in_progress', { response: { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] } });
      push('response.output_item.added', { output_index:0, item:{ id:iid, type:'message', status:'in_progress', role:'assistant', content:[] } });
      push('response.content_part.added', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text:'', annotations:[] } });
      let streamObj;
      try{
        streamObj = await callUpstreamSmart(chat, true);
      }catch(eUp){
        clearHb();
        const em = (eUp&&eUp.message)||String(eUp);
        console.error('[responses][upstream] FAIL before stream err='+em+' model='+reqModel);
        push('response.completed', { response: { id:rid, object:'response', status:'failed', model:reqModel, output:[], error:{ message: em } } });
        return res.end(()=>{ console.log('[responses] RES_ENDED model='+reqModel+' upstream-fail'); });
      }
      const reader = streamObj.getReader();
      (async()=>{
        try{
          while(true){
            const { done, value } = await reader.read();
            if(done) break;
            if(value && value.length){
              buf += decoder.decode(value,{stream:true});
              const parts = buf.split('\n'); buf = parts.pop();
            for(const line of parts){
              const s = line.trim();
              if(!s.startsWith('data:')) continue;
              const d = s.slice(5).trim();
              if(d==='[DONE]') continue;
              let j; try{ j = JSON.parse(d); }catch(e){ continue; }
              const dc = j.choices && j.choices[0] && j.choices[0].delta;
              if(dc && dc.content){ text += dc.content; deltaCount++; push('response.output_text.delta', { item_id:iid, output_index:0, content_index:0, delta: dc.content }); }
              // ---- 工具调用：把上游 chat 格式的 delta.tool_calls 转成 Responses function_call 事件 ----
              if(dc && (dc.tool_calls || dc.function_call)){
                const tcs = dc.tool_calls || (dc.function_call ? [{index:0,function:dc.function_call}] : []);
                for(const tc of tcs){
                  const idx = (tc.index!=null?tc.index:0);
                  const prevArgs = (toolCalls[idx]&&toolCalls[idx].args)||'';
                  if(!toolCalls[idx]) toolCalls[idx] = { id:'fc_'+rid+'_'+idx, name:'', args:'', added:false };
                  const t = toolCalls[idx];
                  if(tc.function && tc.function.name) t.name = tc.function.name;
                  if(tc.function && tc.function.arguments) t.args += tc.function.arguments;
                  if(!t.added && t.name){
                    t.added = true;
                    if(customNames.has(t.name)){
                      // custom 工具（如 codex 的 exec）：Responses 规范用 custom_tool_call 项，input 为原始输入
                      push('response.output_item.added', { output_index: idx+1, item:{ id:t.id, type:'custom_tool_call', status:'in_progress', name:t.name, input:'', call_id:'call_'+t.id } });
                    } else {
                      push('response.output_item.added', { output_index: idx+1, item:{ id:t.id, type:'function_call', status:'in_progress', name:t.name, arguments:'', call_id:'call_'+t.id } });
                    }
                  }
                  if(!customNames.has(t.name) && t.args.length > prevArgs.length){
                    push('response.function_call_arguments.delta', { item_id:t.id, output_index: idx+1, delta: t.args.slice(prevArgs.length) });
                  }
                }
              }
            }
            }
          }
          clearHb();
          const outText = text || '';
          console.log('[responses] STREAM_DONE model='+reqModel+' completed=1 deltas='+deltaCount+' textLen='+(text?text.length:0)+' tools='+Object.keys(toolCalls).length);
          push('response.output_text.done', { item_id:iid, output_index:0, content_index:0, text: outText });
          push('response.content_part.done', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text: outText, annotations:[] } });
          push('response.output_item.done', { output_index:0, item:{ id:iid, type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] } });
          // 收尾每个 function_call item（arguments.done + output_item.done），并纳入 completed.output
          const fcItems = [];
          const fcIdxs = Object.keys(toolCalls).map(Number).sort((a,b)=>a-b);
          for(const idx of fcIdxs){
            const t = toolCalls[idx];
            const oi = idx+1;
            const finalArgs = unwrapArgs(t.name, t.args);
            if(customNames.has(t.name)){
              push('response.custom_tool_call_input.done', { item_id:t.id, output_index:oi, input:finalArgs });
              push('response.output_item.done', { output_index:oi, item:{ id:t.id, type:'custom_tool_call', status:'completed', name:t.name, input:finalArgs, call_id:'call_'+t.id, output:'' } });
              fcItems.push({ type:'custom_tool_call', status:'completed', name:t.name, input:finalArgs, call_id:'call_'+t.id, output:'' });
            } else {
              push('response.function_call_arguments.done', { item_id:t.id, output_index:oi, arguments:finalArgs });
              push('response.output_item.done', { output_index:oi, item:{ id:t.id, type:'function_call', status:'completed', name:t.name, arguments:finalArgs, call_id:'call_'+t.id, output:'' } });
              fcItems.push({ type:'function_call', status:'completed', name:t.name, arguments:finalArgs, call_id:'call_'+t.id, output:'' });
            }
          }
          const outItems = [];
          if(outText) outItems.push({ type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] });
          for(const fi of fcItems) outItems.push(fi);
          push('response.completed', { response: { id:rid, object:'response', status:'completed', model:reqModel, output: outItems, usage:null } });
          res.end(()=>{ console.log('[responses] RES_ENDED model='+reqModel+' completed=1'); });
        }catch(e){
          clearHb();
          console.error('[responses][stream] FAIL err='+((e&&e.message)||String(e))+' model='+reqModel);
          if(!res.writableEnded){
            const outText = text || '';
            console.log('[responses] STREAM_DONE model='+reqModel+' completed=0 deltas='+deltaCount+' err='+((e&&e.message)||String(e)));
            push('response.output_text.done', { item_id:iid, output_index:0, content_index:0, text: outText });
            push('response.content_part.done', { item_id:iid, output_index:0, content_index:0, part:{ type:'output_text', text: outText, annotations:[] } });
            push('response.output_item.done', { output_index:0, item:{ id:iid, type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] } });
            const fcItems = [];
            const fcIdxs = Object.keys(toolCalls).map(Number).sort((a,b)=>a-b);
            for(const idx of fcIdxs){
              const t = toolCalls[idx];
              const oi = idx+1;
              const finalArgs = unwrapArgs(t.name, t.args);
              if(customNames.has(t.name)){
                push('response.custom_tool_call_input.done', { item_id:t.id, output_index:oi, input:finalArgs });
                push('response.output_item.done', { output_index:oi, item:{ id:t.id, type:'custom_tool_call', status:'completed', name:t.name, input:finalArgs, call_id:'call_'+t.id, output:'' } });
                fcItems.push({ type:'custom_tool_call', status:'completed', name:t.name, input:finalArgs, call_id:'call_'+t.id, output:'' });
              } else {
                push('response.function_call_arguments.done', { item_id:t.id, output_index:oi, arguments:finalArgs });
                push('response.output_item.done', { output_index:oi, item:{ id:t.id, type:'function_call', status:'completed', name:t.name, arguments:finalArgs, call_id:'call_'+t.id, output:'' } });
                fcItems.push({ type:'function_call', status:'completed', name:t.name, arguments:finalArgs, call_id:'call_'+t.id, output:'' });
              }
            }
            const outItems = [];
            if(outText) outItems.push({ type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text: outText, annotations:[]}] });
            for(const fi of fcItems) outItems.push(fi);
            push('response.completed', { response: { id:rid, object:'response', status:'completed', model:reqModel, output: outItems, usage:null } });
            res.end(()=>{ console.log('[responses] RES_ENDED model='+reqModel+' completed=0'); });
          }
        }
      })();
    } else {
      const r = await callUpstreamSmart(chat, false);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(chatToResponses(r, reqModel)));
    }
  }catch(e){
    const st = (e && e.status) ? e.status : 502;
    if(!res.headersSent){ res.writeHead(st,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}})); }
    else if(!res.writableEnded) res.end();
  }
}

// WS 模式（codex 专用）：把每个 WS 消息当作一次 /responses 请求，内部转发给本机 HTTP /responses
// （复用现有 SSE 逻辑，强制 stream:true），再把 SSE 每行 data: 载荷原样作为 WS 文本帧发回。
// 连接保持，支持 codex 多轮复用。兼容 codex 同一轮内多次工具调用的「增量 input + previous_response_id」
// （无状态网关无法缓存上一轮上下文，故在此按连接合并回完整 input）。
function handleWsResponses(ws){
  let lastInput = null; // 本连接上一次的完整 input 数组
  ws.on('message', (data)=>{
    let reqJson;
    try{ reqJson = JSON.parse(data.toString()); }
    catch(e){ try{ ws.send(JSON.stringify({type:'error',status:400,error:{code:400,message:'invalid json'}})); }catch(_){} return; }
    if(reqJson && reqJson.type==='response.create'){ delete reqJson.type; }
    reqJson = reqJson || {};
    // codex 同一轮内多次工具调用会发「增量 input + previous_response_id」；合并回完整 input
    if(Array.isArray(reqJson.input) && lastInput && Array.isArray(lastInput) && reqJson.previous_response_id){
      reqJson.input = lastInput.concat(reqJson.input);
      delete reqJson.previous_response_id;
    }
    reqJson.stream = true; // 强制流式，确保事件逐条返回
    const bodyStr = JSON.stringify(reqJson);
    if(Array.isArray(reqJson.input)) lastInput = reqJson.input;
    let buf='';
    const flush = ()=>{
      let idx;
      while((idx = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, idx); buf = buf.slice(idx+1);
        const t = line.trim();
        if(t.startsWith('data:')){
          const p = t.slice(5).trim();
          if(p && p!=='[DONE]'){ try{ ws.send(JSON.stringify(JSON.parse(p))); }catch(_){} }
        }
      }
    };
    const httpReq = http.request({
      host:'127.0.0.1', port: PORT, path:'/responses', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+AUTH_TOKEN, 'Content-Length': Buffer.byteLength(bodyStr) }
    }, (upRes)=>{
      upRes.setEncoding('utf-8');
      upRes.on('data', (chunk)=>{ buf += chunk; flush(); });
      upRes.on('end', ()=>{ flush(); }); // 本轮结束，保持连接等待下一轮
      upRes.on('error', (e)=>{ try{ ws.send(JSON.stringify({type:'error',status:502,error:{code:502,message:e.message}})); }catch(_){} });
    });
    httpReq.on('error', (e)=>{ try{ ws.send(JSON.stringify({type:'error',status:502,error:{code:502,message:e.message}})); }catch(_){} });
    httpReq.write(bodyStr); httpReq.end();
  });
  ws.on('error', ()=>{});
  ws.on('close', ()=>{});
}

function handle(req,res){
  const chunks=[];
  const __t0=Date.now();
  res.on('finish',()=>{ if(res.statusCode!==200){ console.log(req.method+' '+req.url.split('?')[0]+' -> '+res.statusCode+' ('+(Date.now()-__t0)+'ms)'); } });
  // WebSocket：codex 0.147+ 的 WS 模式（Responses API over WebSocket，专用于降低 agent 循环延迟）。
  // 协议（已对照 openai/codex 源码验证）：
  //   客户端→服务端：每轮一个 TEXT 帧 = 标准 Responses 请求 JSON + 顶层 "type":"response.create"（转发前剥掉）。
  //   服务端→客户端：每个 TEXT 帧 = 一个裸 response.* 事件 JSON（与 SSE 的 data: 载荷完全相同，仅去掉 data: 前缀与 SSE 封装）。
  //   收到 response.completed 即本轮结束，连接保持复用多轮。
  // 仅 /responses、/v1/responses 支持 WS；其余路径仍 426。
  if((req.headers['upgrade']||'').toLowerCase().includes('websocket')){
    const u = (req.url||'').split('?')[0];
    const auth = (req.headers['authorization']||req.headers['Authorization']||'');
    const token = auth.startsWith('Bearer ')?auth.slice(7):(auth||'');
    if(AUTH_TOKEN && token.trim()!==AUTH_TOKEN){
      res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'unauthorized'}}));
    }
    if(u==='/responses' || u==='/v1/responses'){
      wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws)=>{ console.log('[hermes][WS] upgrade ok path='+u); handleWsResponses(ws); });
      return;
    }
    req.resume(); // 丢弃可能的请求体，避免连接挂起
    res.writeHead(426,{'Content-Type':'application/json','Connection':'close'});
    return res.end(JSON.stringify({error:{message:'websocket not supported for this path'}}));
  }
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
      const reqModel = payload.model || 'hy3';
      if(isAnthropic){ payload = anthropicToOpenAI(payload); }
      else if(payload.model && MODEL_MAP[payload.model]){ payload.model = MODEL_MAP[payload.model]; }
      // 原生 OpenAI chat/completions 直传请求：同样检测图片，带图走视觉上游（不带图行为完全不变）
      if(!isAnthropic && !payload.__vision && Array.isArray(payload.messages)) payload.__vision = hasVision(payload.messages);
      const stream = !!payload.stream;

      if(stream){
        const streamObj = await callUpstreamSmart(payload, true);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
        // 保活：prefill 期间上游可能数十秒无字节，客户端/代理 idle 超时仍会掐断长 SSE 流；
        // 周期发 SSE 注释（: 开头，客户端忽略但重置 idle 计时），流收尾时清除。
        let hbCleared=false;
        const clearHb=()=>{ if(!hbCleared){ hbCleared=true; try{ clearInterval(hb); }catch(_){} } };
        const hb=setInterval(()=>{ try{ res.write(': ping\n\n'); }catch(_){} }, 3000);
        const reader = streamObj.getReader();
        const decoder = new TextDecoder('utf-8');
        if(isAnthropic){
          streamOpenAIToAnthropic(reader, decoder, res, reqModel)
            .catch(e=>{ if(!res.writableEnded) res.end(); })
            .finally(clearHb);
        } else {
          (async()=>{
            try{
              while(true){
                const { done, value } = await reader.read();
                if(done) break;
                res.write(decoder.decode(value, { stream:true }));
              }
            } finally { clearHb(); }
            if(!res.writableEnded) res.end();
          })().catch(()=>{ clearHb(); if(!res.writableEnded) res.end(); });
        }
      } else {
        const r = await callUpstreamSmart(payload, false);
        if(isAnthropic){
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(openAIToAnthropic(r, reqModel)));
        } else {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(r));
        }
      }
    }catch(e){
      const st = (e && e.status) ? e.status : 502;
      if(!res.headersSent){
        res.writeHead(st,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}}));
      } else { try{ res.end(); }catch(_){} }
    }
  });
}
const server=http.createServer(handle);
// WebSocket 服务（noServer：由 handle 在 upgrade 分支里手动 handleUpgrade，复用同一 handle 逻辑）
const wss = new WebSocket.Server({ noServer: true });
wss.on('error', e=>console.error('[hermes][WS-ERR]', e.message));
server.listen(PORT, process.env.LISTEN || '127.0.0.1', ()=>console.log('hermes-proxy v5 (env='+ENV_ID+') on '+process.env.LISTEN||'127.0.0.1'+':'+PORT));

// ---------- 可选 HTTPS 层（域名直连，绕过 Cloudflare Tunnel 以免长 SSE 流被掐断） ----------
// 设置 SSL_CERT / SSL_KEY（PEM 路径）即在本机终止 TLS，监听 443，复用同一 handle。
// 不设置则只跑 HTTP :8787，行为完全不变（可逆）。
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY  = process.env.SSL_KEY  || '';
if (SSL_CERT && SSL_KEY) {
  try {
    const tlsOpts = { cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) };
    const httpsServer = https.createServer(tlsOpts, handle);
    const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
    httpsServer.listen(HTTPS_PORT, process.env.LISTEN || '0.0.0.0', ()=>{
      console.log('hermes-proxy v5 HTTPS on :'+HTTPS_PORT+' (env='+ENV_ID+')');
    });
    httpsServer.on('error', e=>console.error('[hermes][HTTPS-ERR]', e.message));
  } catch(e) {
    console.error('[hermes][HTTPS] 启动失败，仅 HTTP 可用：', e.message);
  }
}
