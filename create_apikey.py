#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 SecretId/SecretKey 调用腾讯云 OpenAPI CreateApiKey 创建新的 CloudBase API Key (TC3 签名)"""
import hashlib, hmac, json, re, sys, datetime, urllib.request, urllib.error

APKEY_TXT = r"C:\Users\dongxiaotong\Desktop\大模型网关\apikey.txt"

def parse_envs(txt):
    """解析 apikey.txt 两个环境块, 返回 [(env, sid, skey), ...]"""
    out = []
    for seg_name in ["一：", "二："]:
        if seg_name not in txt:
            continue
        seg = txt.split(seg_name)[1]
        seg = seg.split("三：")[0] if "三：" in seg else seg
        m_env = re.search(r"https://([a-z0-9-]+)\.api\.tcloudbasegateway\.com", seg)
        m_sid = re.search(r"SecretId\s*\n\s*([A-Za-z0-9]+)", seg)
        m_skey = re.search(r"SecretKey\s*\n\s*([A-Za-z0-9]+)", seg)
        if m_env and m_sid and m_skey:
            out.append((m_env.group(1), m_sid.group(1), m_skey.group(1)))
    return out

def tc3_sign(secret_id, secret_key, action, payload, service="tcb", host="tcb.tencentcloudapi.com", version="2018-06-08", region=""):
    import time
    ts = int(time.time())  # 真实 UTC 时间戳
    date = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    body = json.dumps(payload, ensure_ascii=False)
    hashed_payload = hashlib.sha256(body.encode("utf-8")).hexdigest()

    canonical_headers = f"content-type:application/json\nhost:{host}\nx-tc-action:{action.lower()}\n"
    signed_headers = "content-type;host;x-tc-action"
    canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"

    credential_scope = f"{date}/{service}/tc3_request"
    string_to_sign = f"TC3-HMAC-SHA256\n{ts}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"

    def _hmac(key, msg):
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, service)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, "
                     f"SignedHeaders={signed_headers}, Signature={signature}")

    headers = {
        "Content-Type": "application/json",
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Timestamp": str(ts),
        "Authorization": authorization,
    }
    if region:
        headers["X-TC-Region"] = region
    req = urllib.request.Request(f"https://{host}/", data=body.encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")

def main():
    with open(APKEY_TXT, "r", encoding="utf-8") as f:
        txt = f.read()
    envs = parse_envs(txt)
    print("发现环境:", [(e, s[:8] + "...") for e, s, _ in envs])
    for env, sid, skey in envs:
        payload = {"EnvId": env, "KeyType": "api_key", "KeyName": "hy3-backup"}
        # 依次尝试常见区域
        for region in ["ap-shanghai", "ap-guangzhou", "ap-beijing", "ap-hongkong", "na-siliconvalley"]:
            code, resp = tc3_sign(sid, skey, "CreateApiKey", payload, region=region)
            rj = {}
            try:
                rj = json.loads(resp)
            except Exception:
                pass
            if rj.get("Response") and "Error" not in rj["Response"]:
                print(f"\n=== {env} CreateApiKey -> HTTP {code} (region={region}) ===")
                rr = rj["Response"]
                print("KeyId:", rr.get("KeyId"))
                print("Name:", rr.get("Name"))
                print("ExpireAt:", rr.get("ExpireAt"))
                print("ApiKey(JWT):", (rr.get("ApiKey") or "")[:80] + "...")
                break
            if rj.get("Response") and rj["Response"].get("Error"):
                err = rj["Response"]["Error"]
                if err.get("Code") == "MissingParameter":
                    continue
                print(f"\n=== {env} CreateApiKey -> HTTP {code} (region={region}) ===")
                print("ERROR:", err.get("Code"), err.get("Message"))
                break
        else:
            print(f"\n=== {env}: 所有区域都缺 Region/失败，最后响应: {resp[:200]} ===")

if __name__ == "__main__":
    main()
