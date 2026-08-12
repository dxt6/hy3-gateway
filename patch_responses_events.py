import subprocess, sys

LOCAL = r"C:\Users\dongxiaotong\Desktop\大模型网关\hermes_proxy_server_v5.js"
REMOTE = "root@118.24.71.189:/opt/hermes_proxy/server.js"
KEY = r"C:\Users\dongxiaotong\.ssh\id_ed25519"

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print("ERR:", r.stderr); sys.exit(1)
    return r

src = open(LOCAL, encoding='utf-8').read()

# (1) 恢复 [responses] IN 诊断日志（请求进入时打印，用 console.log 确保进 journald）
OLD_IN = "  const chat = responsesToChat(payload);\n  const reqModel = chat.model;"
NEW_IN = "  const chat = responsesToChat(payload);\n  const reqModel = chat.model;\n  console.log('[responses] IN model='+(payload&&payload.model)+' stream='+(!!(payload&&payload.stream))+' nMsgs='+(Array.isArray(payload&&payload.input)?payload.input.length:0));"
if OLD_IN not in src:
    print("IN_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_IN, NEW_IN, 1)

# (2) 补全 Responses 流式标准事件序列（output_item.added / content_part.added / delta / content_part.done / output_item.done / completed）
OLD_STREAM = """      const rid = 'resp_'+Date.now();
      push('response.created', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
      push('response.in_progress', { id:rid, object:'response', status:'in_progress', model:reqModel, output:[] });
      (async()=>{
        try{
          while(true){
            const { done, value } = await reader.read();
            if(done) break;
            buf += decoder.decode(value,{stream:true});
            const parts = buf.split('\\n'); buf = parts.pop();
            for(const line of parts){
              const s = line.trim();
              if(!s.startsWith('data:')) continue;
              const d = s.slice(5).trim();
              if(d==='[DONE]') continue;
              let j; try{ j = JSON.parse(d); }catch(e){ continue; }
              const dc = j.choices && j.choices[0] && j.choices[0].delta;
              if(dc && dc.content){ text += dc.content; push('response.output_text.delta', { delta: dc.content, item_id:'msg_'+rid, content_index:0 }); }
            }
          }
          push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: text, annotations:[]}]}], usage:null });
          res.end();
        }catch(e){
          console.error('[responses][stream] FAIL err='+((e&&e.message)||String(e))+' model='+reqModel);
          if(!res.writableEnded){
            push('response.completed', { id:rid, object:'response', status:'completed', model:reqModel, output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text: text, annotations:[]}]}], usage:null });
            res.end();
          }
        }
      })();"""

NEW_STREAM = """      const rid = 'resp_'+Date.now();
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
            const parts = buf.split('\\n'); buf = parts.pop();
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
      })();"""

if OLD_STREAM not in src:
    print("STREAM_OLD_NOT_FOUND"); sys.exit(1)
src = src.replace(OLD_STREAM, NEW_STREAM, 1)

open(LOCAL, 'w', encoding='utf-8').write(src)
print("PATCHED_LOCAL")

node = r"C:\Users\dongxiaotong\.workbuddy\binaries\node\versions\22.22.2\node.exe"
r = run(f'"{node}" -c "{LOCAL}"')
print("SYNTAX_OK")

r = run(f'ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "cp /opt/hermes_proxy/server.js /opt/hermes_proxy/server.js.bak_before_events"')
r = run(f'scp -i "{KEY}" -o StrictHostKeyChecking=no "{LOCAL}" {REMOTE}')
print("SCP_OK")
r = run(f'ssh -i "{KEY}" -o StrictHostKeyChecking=no root@118.24.71.189 "node -c /opt/hermes_proxy/server.js && systemctl restart hermes-proxy && sleep 1 && systemctl is-active hermes-proxy"')
print(r.stdout.strip())
print("DONE")
