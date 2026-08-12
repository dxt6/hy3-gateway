# -*- coding: utf-8 -*-
"""错误类型: 把 HTTP 状态码/网关业务码映射成可读异常。"""


class CloudBaseAIError(Exception):
    """基类。"""

    def __init__(self, message, *, status=None, code=None, raw=None):
        super().__init__(message)
        self.message = message
        self.status = status      # HTTP 状态码
        self.code = code          # 网关业务码 (如 AI_CHANNEL_NOT_ALLOWED)
        self.raw = raw            # 原始响应体

    def __str__(self):
        bits = []
        if self.status is not None:
            bits.append(f"HTTP {self.status}")
        if self.code:
            bits.append(f"code={self.code}")
        return f"[{' '.join(bits)}] {self.message}"


class AuthError(CloudBaseAIError):
    """401 — 鉴权失败 (key 无效/过期)。"""


class ChannelNotAllowed(CloudBaseAIError):
    """403 — AI_CHANNEL_NOT_ALLOWED: 通道白名单限制(小程序成长计划)。"""


class NotFound(CloudBaseAIError):
    """404 — 路径不存在。"""


class RateLimitError(CloudBaseAIError):
    """429 — 限流。"""


class ServerError(CloudBaseAIError):
    """5xx — 服务端错误。"""


def from_response(status, body_text):
    """根据 HTTP 状态码和响应体构造异常。"""
    code = None
    msg = body_text.strip()[:300]
    # 尝试从 JSON 里取业务码/信息
    try:
        import json
        obj = json.loads(body_text)
        if isinstance(obj, dict):
            code = obj.get("code")
            if obj.get("message"):
                msg = obj["message"]
    except Exception:
        pass

    if status == 401:
        return AuthError(msg, status=status, code=code, raw=body_text)
    if status == 403:
        return ChannelNotAllowed(msg, status=status, code=code, raw=body_text)
    if status == 404:
        return NotFound(msg, status=status, code=code, raw=body_text)
    if status == 429:
        return RateLimitError(msg, status=status, code=code, raw=body_text)
    if status and 500 <= status < 600:
        return ServerError(msg, status=status, code=code, raw=body_text)
    return CloudBaseAIError(msg, status=status, code=code, raw=body_text)
