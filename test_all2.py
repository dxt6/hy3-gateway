# -*- coding: utf-8 -*-
"""阶段B v2：全量测试 10 个 key × 候选路径（标签正确版）"""
import json, ssl, base64, datetime, urllib.request, urllib.error, concurrent.futures

TXT = r"C:\Users\dongxiaotong\Desktop\大模型网关\apikey.txt"
MODEL = "hy3"
TIMEOUT = 25

def parse_txt(path):
    with open(path, "r", encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    gateways, keys = {}, {}
    cur = None
    for ln in lines:
        if ln.startswith("一") or ln.startswith("二"):
            cur = ln[0]; gateways[cur] = None; keys[cur] = []
        elif ln.startswith("http"):
            if cur: gateways[cur] = ln
        elif ln.startswith("eyJ"):
            if cur: keys[cur].append(ln)
    return gateways, keys

def jwt_iat(tok):
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        iat = json.loads(base64.urlsafe_b64decode(p))["iat"]
        return datetime.datetime.utcfromtimestamp(iat).strftime("%m-%d %H:%M") + " UTC"
    except Exception:
        return "?"

def http_req(url, key, timeout=TIMEOUT):
    body = json.dumps({"model": MODEL, "max_tokens": 16,
                       "messages": [{"role": "user", "content": "ping"}]}).encode()
    headers = {"Authorization": "Bearer " + key, "content-type": "application/json"}
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

def short(s, n=120):
    return s.replace("\n", " ")[:n]

def worker(g, i, name, url, key):
    code, data = http_req(url, key)
    return g, i, name, code, data

gateways, keys = parse_txt(TXT)
results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    futs = []
    for g, base in gateways.items():
        host = base[:base.index("/v1/ai")]
        urls = [
            ("openai  {base}/chat/completions", base + "/chat/completions"),
            ("openai  {base}/v1/chat/completions", base + "/v1/chat/completions"),
            ("openai  {base} (直接POST)", base),
            ("openai  {host}/v1/chat/completions", host + "/v1/chat/completions"),
            ("anth    {host}/v1/messages", host + "/v1/messages"),
        ]
        for i, k in enumerate(keys[g], 1):
            for name, url in urls:
                futs.append(ex.submit(worker, g, i, name, url, k))
    for f in futs:
        results.append(f.result())

order = {"一": 0, "二": 1}
results.sort(key=lambda r: (order[r[0]], r[1]))
for g, i, name, code, data in results:
    status = "OK " if code == 200 else (f"ERR" if code is None else f"{code}")
    print(f"[{status}] 网关{g} key#{i} (iat {jwt_iat(keys[g][i-1])}) | {name}")
    if code != 200:
        print(f"            {short(data)}")
