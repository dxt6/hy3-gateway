# -*- coding: utf-8 -*-
"""
cloudbase_hy3_sdk
=================

腾讯云开发(CloudBase) AI 网关的轻量转接 SDK，模型名统一为 `hy3`。

【重要·根因说明】
这 10 个 key 是 CloudBase 的 API Key (JWT, client_type=client_server, 长期有效)。
鉴权本身是过的(否则返回 401)。但服务端对该环境开启了「小程序成长计划」通道白名单，
任何非「云开发运行时 / 微信小程序运行时」来源的直连请求都会被 403 拒绝：
    {"code":"AI_CHANNEL_NOT_ALLOWED","message":"小程序成长计划仅支持小程序 SDK 和云开发 SDK 调用。"}

本 SDK 默认走 OpenAI 兼容的 /chat/completions 接口 (Bearer + POST)，
也就是直连方式 —— 在该限制下会返回 403。它已经把 key 轮换、重试、超时、
流式解析、错误归类都做好了；一旦你那边能让请求带合法的云开发运行时上下文
(例如把请求转发到该环境里的一个云函数,由云函数在运行时内调用 AI),
本 SDK 只需把 `base_url` 指向那个云函数代理即可,其余代码一行不用改。

接口形态刻意对齐 OpenAI SDK,方便你直接用 openai 风格的代码:
    from cloudbase_hy3_sdk import Client
    c = Client.from_apikey_txt(r"path/to/apikey.txt")
    r = c.chat.completions.create(model="hy3", messages=[{"role":"user","content":"hi"}])
    print(r.choices[0].message.content)
"""

from .client import Client, Completion, Choice, Message, Usage
from .errors import (
    CloudBaseAIError,
    AuthError,          # 401
    ChannelNotAllowed,  # 403 AI_CHANNEL_NOT_ALLOWED
    NotFound,           # 404
    RateLimitError,     # 429
    ServerError,        # 5xx
)

__all__ = [
    "Client", "Completion", "Choice", "Message", "Usage",
    "CloudBaseAIError", "AuthError", "ChannelNotAllowed",
    "NotFound", "RateLimitError", "ServerError",
]

__version__ = "0.1.0"
