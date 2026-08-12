# -*- coding: utf-8 -*-
"""逐个测试 apikey.txt 里的网关+key，模型名 hy3，判断哪些可用哪些 403。"""
import base64, json, ssl, sys, datetime, urllib.request, urllib.error, concurrent.futures

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
            cur = ln[0]
            gateways[cur] = None
            keys[cur] = []
        elif ln.startswith("http"):
            if cur: gateways[cur] = ln
        elif ln.startswith("eyJ"):
            if cur: keys[cur].append(ln)
    return gateways, keys

def jwt_payload(tok):
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception as e:
        return {"decode_error": str(e)}

def fmt_iat(iat):
    try:
        return datetime.datetime.utcfromtimestamp(iat).strftime("%Y-%m-%d %H:%M:%S") + " UTC"
    except Exception:
        return str(iat)

def http_req(method, url, headers, body, timeout=TIMEOUT):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            data = r.read().decode("utf-8", "replace")
            return r.status, data
    except urllib.error.HTTPError as e:
        data = e.read().decode("utf-8", "replace")
        return e.code, data
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

def short(s, n=220):
    s = s.replace("\n", " ")
    return s[:n]

def test_one(base, key, label):
    results = []
    # Anthropic 风格 (与报错路径 /v1/messages 一致)
    body = json.dumps({"model": MODEL, "max_tokens": 16,
                       "messages": [{"role": "user", "content": "ping"}]}).encode()
    anth_headers = {"x-api-key": key, "anthropic-version": "2023-06-01",
                    "content-type": "application/json"}
    for path in ("/v1/messages",):
        url = base + path
        code, data = http_req("POST", url, anth_headers, body)
        results.append((f"anthropic{path}", code, short(data)))
    # OpenAI 风格
    oai_headers = {"Authorization": "Bearer " + key, "content-type": "application/json"}
    url = base + "/v1/chat/completions"
    code, data = http_req("POST", url, oai_headers, body)
    results.append(("openai/v1/chat/completions", code, short(data)))
    return label, results

def main():
    gateways, keys = parse_txt(TXT)
    print("=== 解析结果 ===")
    for g, base in gateways.items():
        print(f"网关{g}: {base}")
        for k in keys[g]:
            p = jwt_payload(k)
            print(f"   key({p.get('client_type')}, aud={p.get('aud')[:18]}..., "
                  f"iat={fmt_iat(p.get('iat'))}, exp={fmt_iat(p.get('exp'))})")
    print()
    print("=== 开始测试 (model=hy3) ===")
    tasks = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for g, base in gateways.items():
            for i, k in enumerate(keys[g], 1):
                label = f"网关{g} key#{i}"
                tasks.append(ex.submit(test_one, base, k, label))
        for fut in concurrent.futures.as_completed(tasks):
            label, results = fut.result()
            for style, code, data in results:
                tag = "OK" if code == 200 else ("FAIL" if code is None else f"HTTP{code}")
                print(f"[{tag}] {label} | {style} -> {code}")
                if data and ("error" in data.lower() or "message" in data.lower() or code is None):
                    print(f"        body: {data}")
    print()
    print("=== 完成 ===")

if __name__ == "__main__":
    main()
