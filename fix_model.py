import subprocess, sys

SSH = "ssh -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@118.24.71.189"
SCP = "scp -i C:/Users/dongxiaotong/.ssh/id_ed25519 -o StrictHostKeyChecking=no"
REMOTE = "root@118.24.71.189"
SRV = "/opt/hermes_proxy/server.js"
LOCAL = "C:/Users/dongxiaotong/Desktop/大模型网关/server_fix_tmp.js"

# 网关本质是把所有模型代理到 hy3-preview；/responses 收到未登记的模型名（如 o4-mini / gpt-5-codex）
# 时不应透传给 CloudBase（会被拒），统一回落到 hy3-preview。
OLD = "    model: MODEL_MAP[b.model] || b.model || 'hy3-preview',"
NEW = "    model: MODEL_MAP[b.model] || 'hy3-preview',"

r = subprocess.run(f'{SSH} "cat {SRV}"', shell=True, capture_output=True, text=True)
src = r.stdout
if OLD not in src:
    print("OLD not found. Context:")
    for ln in src.splitlines():
        if 'MODEL_MAP[b.model]' in ln:
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
