# -*- coding: utf-8 -*-
"""
使用示例。直接 `python example.py` 运行(会自动做连通性自检)。

注意: 在当前「小程序成长计划」通道白名单限制下, 直连会返回 403。
SDK 会把错误清晰地归类成 ChannelNotAllowed, 并打印根因与破局方案。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from cloudbase_hy3_sdk import Client, ChannelNotAllowed

APIKEY_TXT = r"C:\Users\dongxiaotong\Desktop\大模型网关\apikey.txt"


def main():
    client = Client.from_apikey_txt(APIKEY_TXT)
    print("==== 已加载网关 ====")
    print(client.summary())
    print()

    print("==== 发起一次 hy3 调用(直连) ====")
    try:
        out = client.chat.completions.create(
            model="hy3",
            messages=[{"role": "user", "content": "你好，介绍一下自己"}],
            max_tokens=128,
        )
        print("回复:", out.choices[0].message.content)
    except ChannelNotAllowed as e:
        print(f"[预期中的 403] {e}")
        print()
        print("根因: 该 CloudBase 环境开启了「小程序成长计划」通道白名单, ")
        print("       仅允许「云开发运行时(云函数)」或「微信小程序」来源调用 AI。")
        print("       纯本地 HTTP / 官方 Node SDK 直连都会被这道白名单拦截。")
        print()
        print("破局方案(任选其一):")
        print("  1) 走云函数跳板: 在该环境部署一个云函数, 由云函数在运行时内调用 hy3;")
        print("     本地把这个 SDK 的 base_url 指向云函数代理地址即可(代码不用改)。")
        print("  2) 联系环境管理员, 确认是否有非「小程序成长计划」的 AI 通道 / 关闭该白名单。")
    except Exception as e:
        print(f"[其他错误] {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
