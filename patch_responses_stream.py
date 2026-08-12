import re, subprocess, sys

LOCAL = r"C:\Users\dongxiaotong\Desktop\大模型网关\hermes_proxy_server_v5.js"
REMOTE = "root@118.24.71.189:/opt/hermes_proxy/server.js"
KEY = r"C:\Users\dongxiaotong\.ssh\id_ed25519"
NL = "String.fromCharCode(10)"

OLD_TRIM = r'''// ---------- 上下文保护（防止超大历史把上游挂死 + 控制 prefill 耗时） ----------
const MAX_CTX_EST = 32000;   // 估算 token 上限（hy3 窗口保守值；32K 实测 prefill ~4s，96K 要 10s+）
const MAX_MSG_KEEP = 60;     // 最多保留消息条数
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
        if(b && b.type==='tool_result' && typeof b.content==='string' && b.content.length>2000){
          b.content = b.content.slice(0,2000)+'\n...[truncated by gateway]';
        }
      }
    }
  }
}
'''

NEW_TRIM = r'''// ---------- 上下文保护（保守策略：默认 100% 保留，仅极端情况才动） ----------
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
          b.content = b.content.slice(0, SINGLE_TOOL_MAX) + ''' + NL + r''' + '...[gateway: tool_result truncated to '+SINGLE_TOOL_MAX+' chars]';
        }
      }
    }
  }
}
'''

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print("ERR:", r.stderr); sys.exit(1)
    return r

src = open(LOCAL, encoding='utf-8').read()
if OLD_TRIM not in src:
    print("TRIM_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_TRIM, NEW_TRIM, 1)

# 流式：累积文本 + 出错仍发 completed + 打日志
src = src.replace("      let buf='';", "      let buf=''; let text='';", 1)
OLD_DELTA = "              if(dc && dc.content) push('response.output_text.delta', { delta: dc.content, item_id:'msg_'+Date.now(), content_index:0 });"
NEW_DELTA = "              if(dc && dc.content){ text += dc.content; push('response.output_text.delta', { delta: dc.content, item_id:'msg_'+rid, content_index:0 }); }"
if OLD_DELTA not in src:
    print("DELTA_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_DELTA, NEW_DELTA, 1)

OLD_DONE = "          push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'',annotations:[]}]}], usage:null });"
NEW_DONE = "          push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: text, annotations:[]}]}], usage:null });"
if OLD_DONE not in src:
    print("DONE_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_DONE, NEW_DONE, 1)

OLD_CATCH = "        }catch(e){ if(!res.writableEnded) res.end(); }"
NEW_CATCH = "        }catch(e){\n          console.error('[responses][stream] FAIL err='+((e&&e.message)||String(e))+' model='+reqModel);\n          if(!res.writableEnded){\n            push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: text, annotations:[]}]}], usage:null });\n            res.end();\n          }\n        }"
if OLD_CATCH not in src:
    print("CATCH_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_CATCH, NEW_CATCH, 1)

open(LOCAL, 'w', encoding='utf-8').write(src)
print("PATCHED_LOCAL")

node = r"C:\Users\dongxiaotong\.workbuddy\binaries\node\versions\22.22.2\node.exe"
r = run(f'"{node}" -c "{LOCAL}"')
print("SYNTAX_OK")

r = run(f'ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "cp /opt/hermes_proxy/server.js /opt/hermes_proxy/server.js.bak_before_streamfix"')
r = run(f'scp -i "{KEY}" -o StrictHostKeyChecking=no "{LOCAL}" {REMOTE}')
print("SCP_OK")
r = run(f'ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "node -c /opt/hermes_proxy/server.js && systemctl restart hermes-proxy && sleep 1 && systemctl is-active hermes-proxy"')
print(r.stdout.strip())
print("DONE")
