import subprocess, sys

SSH = "ssh -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@118.24.71.189"
SCP = "scp -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no"
REMOTE = "root@118.24.71.189"
SRV = "/opt/hermes_proxy/server.js"
LOCAL = "C:/Users/dongxiaotong/Desktop/大模型网关/server_log_tmp.js"

r = subprocess.run(f'{SSH} "cat {SRV}"', shell=True, capture_output=True, text=True)
src = r.stdout

OLD1 = "  const chat = responsesToChat(payload);\n  const reqModel = chat.model;"
NEW1 = "  const chat = responsesToChat(payload);\n  const reqModel = chat.model;\n  console.error('[responses] IN model='+(payload&&payload.model)+' stream='+(!!(payload&&payload.stream))+' nMsgs='+(chat.messages?chat.messages.length:0)+' input='+JSON.stringify(payload&&payload.input).slice(0,300));"

OLD2 = "  }catch(e){\n    if(!res.headersSent){ res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}})); }\n    else if(!res.writableEnded) res.end();\n  }"
NEW2 = "  }catch(e){\n    console.error('[responses] FAIL err='+((e&&e.message)||String(e))+' body='+String(bodyStr).slice(0,400));\n    if(!res.headersSent){ res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:(e&&e.message)||String(e)}})); }\n    else if(!res.writableEnded) res.end();\n  }"

if OLD1 not in src:
    print("OLD1 not found"); sys.exit(1)
if OLD2 not in src:
    print("OLD2 not found"); sys.exit(1)

src = src.replace(OLD1, NEW1, 1).replace(OLD2, NEW2, 1)
with open(LOCAL, 'w', encoding='utf-8') as f:
    f.write(src)
print("wrote local", len(src))

scp = subprocess.run(f'{SCP} "{LOCAL}" {REMOTE}:{SRV}', shell=True, capture_output=True, text=True)
print("scp rc", scp.returncode)
if scp.returncode != 0:
    print("SCP FAILED", scp.stderr[:300]); sys.exit(1)

chk = subprocess.run(f'{SSH} "node -c {SRV} && echo SYNTAX_OK"', shell=True, capture_output=True, text=True)
print("syntax:", chk.stdout.strip(), chk.stderr.strip()[:200])
