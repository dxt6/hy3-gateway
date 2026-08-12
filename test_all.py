# -*- coding: utf-8 -*-
"""阶段B：全量测试 10 个 key × 候选路径（Bearer 鉴权, model=hy3）"""
import json, ssl, urllib.request, urllib.error, concurrent.futures

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

def short(s, n=180):
    return s.replace("\n", " ")[:n]

gateways, keys = parse_txt(TXT)

def build_urls(base):
    host = base[:base.index("/v1/ai")]
    return {
        "openai {base}/chat/completions": base + "/chat/completions",
        "openai {base}/v1/chat/completions": base + "/v1/chat/completions",
        "openai {base} (direct)": base,
        "openai {host}/v1/chat/completions": host + "/v1/chat/completions",
        "openai {host}/chat/completions": host + "/chat/completions",
        "anth  {host}/v1/messages": host + "/v1/messages",
    }

print(f"=== 阶段B：全量测试 model={MODEL} ===")
tasks = []
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    for g, base in gateways.items():
        urls = build_urls(base)
        for i, k in enumerate(keys[g], 1):
            for name, url in urls.items():
                tasks.append(ex.submit((lambda n, u, kk: (f"网关{g} key#{i}", n, u, *http_req(u, kk))), name, url, k))
    results = [t.result() for t in tasks]

results.sort(key=lambda r: (r[0], r[1]))
for label, name, url, code, data in results:
    status = "OK" if code == 200 else (f"ERR({code})" if code is None else f"HTTP{code}")
    marker = "  <<< 成功" if code == 200 else ""
    print(f"[{status}] {label} | {name}{marker}")
    print(f"         -> {short(data)}")
