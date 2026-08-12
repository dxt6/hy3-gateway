import re, subprocess, sys

LOCAL = r"C:\Users\dongxiaotong\Desktop\大模型网关\hermes_proxy_server_v5.js"
REMOTE = "root@118.24.71.189:/opt/hermes_proxy/server.js"
KEY = r"C:\Users\dongxiaotong\.ssh\id_ed25519"

NEW_FUNC = r'''function responsesToChat( body ){
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
'''

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print("ERR:", r.stderr); sys.exit(1)
    return r

src = open(LOCAL, encoding='utf-8').read()
pat = re.compile(r'function responsesToChat\( body \)\{.*?\n\}\n', re.S)
m = pat.search(src)
if not m:
    print("PATCH_TARGET_NOT_FOUND"); sys.exit(1)
if 'TOOL_CHOICE_GUARD' in src and False:
    pass
src2 = pat.sub(NEW_FUNC + "\n", src, count=1)
open(LOCAL, 'w', encoding='utf-8').write(src2)
print("PATCHED_LOCAL")

# 语法校验
node = r"C:\Users\dongxiaotong\.workbuddy\binaries\node\versions\22.22.2\node.exe"
r = run(f'"{node}" -c "{LOCAL}"')
print("SYNTAX_OK")

# 备份 118 当前 + 覆盖
r = run(f'scp -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189:/opt/hermes_proxy/server.js /opt/hermes_proxy/server.js.bak_before_toolchoice 2>nul || ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "cp /opt/hermes_proxy/server.js /opt/hermes_proxy/server.js.bak_before_toolchoice"')
r = run(f'scp -i "{KEY}" -o StrictHostKeyChecking=no "{LOCAL}" {REMOTE}')
print("SCP_OK")
# 远端语法 + restart
r = run(f'ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "node -c /opt/hermes_proxy/server.js && systemctl restart hermes-proxy && sleep 1 && systemctl is-active hermes-proxy"')
print(r.stdout.strip())
print("DONE")
