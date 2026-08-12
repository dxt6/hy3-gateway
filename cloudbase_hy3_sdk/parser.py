# -*- coding: utf-8 -*-
"""解析 apikey.txt, 以及 OpenAI 风格的结果数据类。"""

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def parse_apikey_txt(path: str):
    """
    解析 apikey.txt。

    文件格式(每区块以 一/二 开头, 跟一个 http 网关地址, 再跟若干 eyJ... 的 key):
        一：
        https://....api.tcloudbasegateway.com/v1/ai/cloudbase
        9：
        eyJhbG...ZuOg
        ...

    返回:
        gateways: { "一": "https://...", "二": "https://..." }
        keys:     { "一": ["eyJ...", ...], "二": ["eyJ...", ...] }
    """
    gateways: Dict[str, Optional[str]] = {}
    keys: Dict[str, List[str]] = {}
    cur = None
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            ln = raw.strip()
            if not ln:
                continue
            if ln.startswith("一") or ln.startswith("二"):
                cur = ln[0]
                gateways[cur] = None
                keys[cur] = []
            elif ln.startswith("http"):
                if cur is not None:
                    gateways[cur] = ln
            elif ln.startswith("eyJ"):
                if cur is not None:
                    keys[cur].append(ln)
    return gateways, keys


def jwt_meta(token: str) -> dict:
    """粗略读出 JWT payload 里的关键字段(aud/env, iat, exp, client_type)。"""
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return {}


@dataclass
class Message:
    role: str
    content: Optional[str] = None
    tool_calls: Optional[list] = None

    @classmethod
    def from_dict(cls, d: dict) -> "Message":
        return cls(role=d.get("role", ""), content=d.get("content"),
                   tool_calls=d.get("tool_calls"))


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "Usage":
        if not d:
            return cls()
        return cls(
            prompt_tokens=d.get("prompt_tokens", 0),
            completion_tokens=d.get("completion_tokens", 0),
            total_tokens=d.get("total_tokens", 0),
        )


@dataclass
class Choice:
    index: int = 0
    message: Optional[Message] = None
    finish_reason: Optional[str] = None
    delta: Optional[dict] = None  # 流式增量

    @classmethod
    def from_dict(cls, d: dict) -> "Choice":
        msg = d.get("message")
        return cls(
            index=d.get("index", 0),
            message=Message.from_dict(msg) if msg else None,
            finish_reason=d.get("finish_reason"),
            delta=d.get("delta"),
        )


@dataclass
class Completion:
    id: str = ""
    object: str = "chat.completion"
    created: int = 0
    model: str = "hy3"
    choices: List[Choice] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict) -> "Completion":
        return cls(
            id=d.get("id", ""),
            object=d.get("object", "chat.completion"),
            created=d.get("created", 0),
            model=d.get("model", "hy3"),
            choices=[Choice.from_dict(c) for c in d.get("choices", [])],
            usage=Usage.from_dict(d.get("usage")),
            raw=d,
        )

    @property
    def content(self) -> str:
        """取第一个 choice 的文本内容(非流式)。"""
        if self.choices and self.choices[0].message:
            return self.choices[0].message.content or ""
        return ""
