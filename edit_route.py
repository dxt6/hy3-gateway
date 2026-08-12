import subprocess, sys

SSH = "ssh -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@118.24.71.189"
SCP = "scp -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no"
REMOTE = "root@118.24.71.189"
SRV = "/opt/hermes_proxy/server.js"
LOCAL = "C:/Users/dongxiaotong/Desktop/大模型网关/server_route_tmp.js"

# 同时匹配 /responses 与 /v1/responses（OpenAI SDK 在 base_url 含 /v1 时会请求 /v1/responses）
OLD = "if(url==='/responses'){ return handleResponses(res, (AUTH_TOKEN? (token.trim()===AUTH_TOKEN):true), body); }"
NEW = "if(url==='/responses' || url==='/v1/responses'){ return handleResponses(res, (AUTH_TOKEN? (token.trim()===AUTH_TOKEN):true), body); }"

r = subprocess.run(f'{SSH} "cat {SRV}"', shell=True, capture_output=True, text=True)
src = r.stdout
if OLD not in src:
    print("OLD not found. Context:")
    for ln in src.splitlines():
        if 'url===/responses' in ln.replace("'", ""):
            print(repr(ln))
    print("aborting"); sys.exit(1)

src = src.replace(OLD, NEW, 1)
with open(LOCAL, 'w', encoding='utf-8') as f:
    f.write(src)
print("wrote local", len(src))

scp = subprocess.run(f'{SCP} "{LOCAL}" {REMOTE}:{SRV}', shell=True, capture_output=True, text=True)
print("scp rc", scp.returncode)
if scp.returncode != 0:
    print("SCP FAILED", scp.stderr[:300]); sys.exit(1)

chk = subprocess.run(f'{SSH} "node -c {SRV} && echo SYNTAX_OK"', shell=True, capture_output=True, text=True)
print("syntax:", chk.stdout.strip(), chk.stderr.strip()[:200])
