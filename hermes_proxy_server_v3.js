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
// Anthropic /v1/messages 请求体 → OpenAI chat/completions 请求体
function anthropicToOpenAI(p){
  const out = { model: MODEL_MAP[p.model]||p.model||'hy3', max_tokens: p.max_tokens||1024 };
  out.messages = (p.messages||[]).map(m=>{
    let content = m.content;
    if(Array.isArray(content)){ content = content.filter(c=>c.type==='text').map(c=>c.text).join(''); }
    if(typeof content!=='string'){ content = JSON.stringify(content); }
    return { role: m.role==='assistant'?'assistant':'user', content };
  });
  if(p.stream!==undefined) out.stream = p.stream;
  if(p.temperature!==undefined) out.temperature = p.temperature;
  if(p.top_p!==undefined) out.top_p = p.top_p;
  return out;
}
// OpenAI chat.completion → Anthropic message
function openAIToAnthropic(buf, reqModel){
  let j = {}; try{ j = JSON.parse(buf); }catch(e){}
  const ch = j.choices && j.choices[0];
  const msg = ch && ch.message || {};
  return {
    id: 'msg_' + (j.id||('m_'+Date.now())),
    type: 'message', role: 'assistant', model: reqModel,
    content: [{ type:'text', text: msg.content||'' }],
    stop_reason: mapStop(ch && ch.finish_reason), stop_sequence: null,
    usage: j.usage ? { input_tokens: j.usage.prompt_tokens||0, output_tokens: j.usage.completion_tokens||0 } : null
  };
}
function sendAnthropicStop(res, fr){
  res.write('event: content_block_stop\ndata: '+JSON.stringify({type:'content_block_stop',index:0})+'\n\n');
  res.write('event: message_delta\ndata: '+JSON.stringify({type:'message_delta',delta:{stop_reason:mapStop(fr),stop_sequence:null},usage:{output_tokens:0}})+'\n\n');
  res.write('event: message_stop\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n');
}
// OpenAI SSE → Anthropic SSE 流式转换
function streamOpenAIToAnthropic(ures, res, reqModel){
  let buffer='', started=false, stopSent=false;
  ures.on('data',chunk=>{
    buffer += chunk.toString();
    let idx;
    while((idx=buffer.indexOf('\n'))>=0){
      const line = buffer.slice(0,idx); buffer = buffer.slice(idx+1);
      if(!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if(!data || data==='[DONE]'){ if(data==='[DONE]' && !stopSent){ stopSent=true; sendAnthropicStop(res); } continue; }
      let j; try{ j = JSON.parse(data); }catch(e){ continue; }
      const ch = j.choices && j.choices[0];
      const delta = ch && ch.delta;
      if(!started){
        res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'msg_'+(j.id||('m_'+Date.now())),type:'message',role:'assistant',model:reqModel,content:[],stop_reason:null,stop_sequence:null,usage:null}})+'\n\n');
        res.write('event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+'\n\n');
        started = true;
      }
      if(delta && delta.content){
        res.write('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:delta.content}})+'\n\n');
      }
      if(ch && ch.finish_reason && !stopSent){ stopSent=true; sendAnthropicStop(res, ch.finish_reason); }
    }
  });
  ures.on('end',()=>{ if(!stopSent){ stopSent=true; sendAnthropicStop(res); } res.end(); });
  ures.on('error',()=>{ if(!stopSent){ stopSent=true; sendAnthropicStop(res); } res.end(); });
}

function handle(req,res){
  let body='';
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
server.listen(PORT,'127.0.0.1',()=>console.log('hermes-proxy v3 (env='+ENV_ID+') on 127.0.0.1:'+PORT));
