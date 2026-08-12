# -*- coding: utf-8 -*-
import json, ssl, urllib.request, urllib.error
from test_all2 import parse_txt, http_req, short

gateways, keys = parse_txt(r"C:/Users/dongxiaotong/Desktop/大模型网关/apikey.txt")

def anth_req(url, key, model="hy3"):
    body = json.dumps({"model": model, "max_tokens": 16,
                       "messages": [{"role": "user", "content": "ping"}]}).encode()
    headers = {"Authorization": "Bearer " + key, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=25, context=ctx) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

for g, base in gateways.items():
    key = keys[g][0]
    print(f"=== 网关{g} (用第一个 key) ===")
    for path in ["/v1/messages", "/messages"]:
        url = base + path
        code, data = anth_req(url, key)
        print(f"  anth {path} -> {code}: {short(data, 160)}")
    # 也试试 OpenAI 兼容路径确认 hy3 全量可用性
    url = base + "/chat/completions"
    code, data = http_req(url, key)
    print(f"  openai /chat/completions -> {code}: {short(data, 160)}")
    print()
