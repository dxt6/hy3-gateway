import subprocess, sys

SSH = "ssh -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@118.24.71.189"
SCP = "scp -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no"
REMOTE = "root@118.24.71.189"
SRV_PATH = "/opt/hermes_proxy/server.js"
LOCAL_TMP = "C:/Users/dongxiaotong/Desktop/大模型网关/server_injected_tmp.js"

PATCH = r'''// ---------- OpenAI Responses API 兼容层（供 codex 等走 /responses 的客户端） ----------
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
      let role = (it.role==='system')?'system':((it.role==='assistant')?'assistant':'user');
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
  if(Array.isArray(b.tools)){
    out.tools = b.tools.filter(t=>t&&t.type==='function').map(t=>({ type:'function', function:{ name: t.name||'', description: t.description||'', parameters: t.parameters||t.input_schema||{type:'object',properties:{}} } }));
  }
  if(b.tool_choice){
    const tc = b.tool_choice;
    if(tc==='auto'||tc==='none') out.tool_choice = tc;
    else if(tc.type==='function') out.tool_choice = { type:'function', function:{ name: tc.name } };
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
  try{
    if(chat.stream){
      const streamObj = await callUpstream(chat, true);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Transfer-Encoding':'chunked','X-Accel-Buffering':'no'});
      const reader = streamObj.getReader(); const decoder = new TextDecoder('utf-8');
      let buf='';
      const push = (evt, data)=>{ res.write('event: '+evt+'\n'); res.write('data: '+JSON.stringify(data)+'\n\n'); };
      const rid = 'resp_'+Date.now();
      push('response.created', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
      push('response.in_progress', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
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
              if(dc && dc.content) push('response.output_text.delta', { delta: dc.content, item_id:'msg_'+Date.now(), content_index:0 });
            }
          }
          push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'',annotations:[]}]}], usage:null });
          res.end();
        }catch(e){ if(!res.writableEnded) res.end(); }
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
'''

def run(cmd):
    print("RUN:", cmd[:120])
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print("STDERR:", r.stderr[:500])
    return r

# 1. read current server.js
r = run(f'{SSH} "cat {SRV_PATH}"')
src = r.stdout
if not src.strip():
    print("FAILED to read server.js"); sys.exit(1)
print("read", len(src), "bytes")

# 2. inject patch before 'function handle(req,res){'
marker = "function handle(req,res){"
if marker not in src:
    print("marker not found"); sys.exit(1)
if "handleResponses" in src:
    print("patch already applied, skip"); sys.exit(0)
new_src = src.replace(marker, PATCH + "\n" + marker, 1)

# 3. inject routing branch: 放在 auth 校验之后、GET /health 处理之前；
#    此处 body 已在主 handler 中解码完成，直接把 body 传给 handleResponses。
route_marker = "if(req.method==='GET' && (url==='/'||url==='/v1'||url==='/health')){"
route_branch = (
"      if(url==='/responses' || url==='/v1/responses'){ return handleResponses(res, (AUTH_TOKEN? (token.trim()===AUTH_TOKEN):true), body); }\n"
)
if route_marker in new_src and "handleResponses(res" not in new_src:
    new_src = new_src.replace(route_marker, route_branch + route_marker, 1)
else:
    print("route marker not found or already present"); sys.exit(1)

with open(LOCAL_TMP, 'w', encoding='utf-8') as f:
    f.write(new_src)
print("written local tmp", len(new_src), "bytes")

# 4. scp back
scp = run(f'{SCP} "{LOCAL_TMP}" {REMOTE}:{SRV_PATH}')
print("scp rc", scp.returncode)
if scp.returncode != 0:
    print("SCP FAILED"); sys.exit(1)

# 5. syntax check
chk = run(f'{SSH} "node -c {SRV_PATH} && echo SYNTAX_OK"')
print("syntax check:", chk.stdout.strip(), "| stderr:", chk.stderr.strip()[:300])
