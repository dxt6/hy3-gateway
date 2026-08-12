# -*- coding: utf-8 -*-
"""CloudBase hy3 客户端: OpenAI 兼容接口 + key 自动轮换 + 重试 + 流式。"""

import json
import ssl
import time
import urllib.request
import urllib.error
from typing import Dict, Iterable, Iterator, List, Optional

from .errors import from_response, CloudBaseAIError
from .parser import parse_apikey_txt, jwt_meta, Completion, Choice, Message, Usage

DEFAULT_TIMEOUT = 60
DEFAULT_RETRIES = 3
DEFAULT_MODEL = "hy3"
# OpenAI 兼容路径(直连方式; 在通道白名单限制下会 403, 见 __init__.py 说明)
CHAT_PATH = "/chat/completions"
# 备选: Anthropic 兼容路径
ANTH_PATH = "/v1/messages"


class _Chat:
    """client.chat 命名空间, 提供 .completions。"""

    def __init__(self, client: "Client"):
        self.completions = _Completions(client)


class _Completions:
    """client.chat.completions.create(...) 命名空间, 对齐 openai SDK 用法。"""

    def __init__(self, client: "Client"):
        self._client = client

    def create(
        self,
        *,
        model: str = DEFAULT_MODEL,
        messages: List[Dict[str, str]],
        max_tokens: Optional[int] = None,
        temperature: float = 0.7,
        stream: bool = False,
        **kwargs,
    ):
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        payload.update(kwargs)

        if stream:
            return self._client._stream(CHAT_PATH, payload, model)
        data = self._client._request(CHAT_PATH, payload)
        return Completion.from_dict(data)


class Client:
    """
    CloudBase hy3 转接客户端。

    用法:
        from cloudbase_hy3_sdk import Client
        c = Client.from_apikey_txt(r"路径/apikey.txt")
        # 或手动:
        c = Client(base_urls={"一": "https://.../v1/ai/cloudbase"},
                   keys={"一": ["eyJ...", ...]})
        out = c.chat.completions.create(model="hy3",
                                        messages=[{"role":"user","content":"你好"}])
        print(out.choices[0].message.content)
    """

    def __init__(
        self,
        *,
        base_urls: Dict[str, str],
        keys: Dict[str, List[str]],
        timeout: int = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        model: str = DEFAULT_MODEL,
        verify_ssl: bool = True,
    ):
        self.base_urls = base_urls
        self.keys = {g: list(v) for g, v in keys.items()}
        self.timeout = timeout
        self.retries = retries
        self.model = model
        self._ctx = ssl.create_default_context() if verify_ssl else self._no_verify()
        # 拉平所有 (gateway, key) 组合, 用于轮换
        self._pool: List[tuple] = []
        for g, ks in self.keys.items():
            base = base_urls.get(g)
            if not base:
                continue
            for k in ks:
                self._pool.append((g, base, k))
        if not self._pool:
            raise ValueError("没有任何可用的网关/key 组合")
        self._cursor = 0
        self.chat = _Chat(self)

    @staticmethod
    def _no_verify():
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    # ---------- 构造器 ----------
    @classmethod
    def from_apikey_txt(cls, path: str, **kw) -> "Client":
        gateways, keys = parse_apikey_txt(path)
        return cls(base_urls=gateways, keys=keys, **kw)

    @classmethod
    def from_single(cls, base_url: str, api_key: str, **kw) -> "Client":
        return cls(base_urls={"default": base_url}, keys={"default": [api_key]}, **kw)

    # ---------- 内部 HTTP ----------
    def _next_credential(self) -> tuple:
        g, base, k = self._pool[self._cursor % len(self._pool)]
        self._cursor += 1
        return g, base, k

    def _build_req(self, url: str, payload: dict, key: str, anth: bool = False):
        body = json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json"}
        if anth:
            headers["x-api-key"] = key
            headers["anthropic-version"] = "2023-06-01"
            headers["Authorization"] = "Bearer " + key
        else:
            headers["Authorization"] = "Bearer " + key
        return urllib.request.Request(url, data=body, headers=headers, method="POST")

    def _request(self, path: str, payload: dict, anth: bool = False) -> dict:
        last_err: Optional[Exception] = None
        for attempt in range(self.retries * max(1, len(self._pool))):
            g, base, key = self._next_credential()
            url = base + path
            req = self._build_req(url, payload, key, anth)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as r:
                    data = r.read().decode("utf-8", "replace")
                    return json.loads(data)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                err = from_response(e.code, body)
                # 403 通道限制 / 401 鉴权: 换下一个 key 重试, 但这类错误重试无意义(所有 key 同环境)
                if isinstance(err, CloudBaseAIError) and err.status in (401, 403, 404):
                    last_err = err
                    # 仍然推进 cursor 试别的 key/gateway, 但记录首个错误
                    if attempt == 0:
                        self._first_hard_err = err
                    continue
                last_err = err
                if getattr(err, "status", None) and 500 <= err.status < 600:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                raise err
            except Exception as e:  # 网络层错误: 重试
                last_err = e
                time.sleep(min(2 ** attempt, 8))
        # 用首个硬错误优先抛出(403 通道限制是最可能的原因)
        if getattr(self, "_first_hard_err", None):
            raise self._first_hard_err
        raise CloudBaseAIError(f"所有重试均失败: {last_err}")

    def _stream(self, path: str, payload: dict, model: str) -> Iterator[Completion]:
        """SSE 流式: 逐行解析 data: {...}, 返回增量 Completion 对象。"""
        g, base, key = self._pool[0]
        url = base + path
        req = self._build_req(url, payload, key)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as r:
                for line in r:
                    line = line.decode("utf-8", "replace").strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except Exception:
                        continue
                    yield Completion.from_dict(obj)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise from_response(e.code, body)
        except Exception as e:
            raise CloudBaseAIError(f"流式请求失败: {e}")

    # ---------- Anthropic 兼容(备选) ----------
    def create_message(self, *, messages, max_tokens=512, model=DEFAULT_MODEL, stream=False):
        """Anthropic 风格 /v1/messages。与 OpenAI 风格返回不同, 直接返回原始 dict。"""
        payload = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if stream:
            return self._stream(ANTH_PATH, payload, model)
        return self._request(ANTH_PATH, payload, anth=True)

    # ---------- 工具 ----------
    def summary(self) -> str:
        lines = []
        for g, ks in self.keys.items():
            base = self.base_urls.get(g, "?")
            meta = jwt_meta(ks[0]) if ks else {}
            env = meta.get("aud", "?")
            lines.append(f"网关 {g}: {base}\n  env={env}  key 数量={len(ks)}")
        return "\n".join(lines)


__all__ = ["Client", "Completion", "Choice", "Message", "Usage"]
