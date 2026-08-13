#!/usr/bin/env bash
# ============================================================
#  hy3-gateway 本地启动脚本（模板，不含凭据）
#  复制本文件为 start_local_gateway.sh（该名已被 .gitignore 忽略）
#  然后二选一填值：
#     A. 新建 .env.local（复制自 .env.example）并填写真实值 —— 本脚本自动 source；
#     B. 或 export CB_ENV_ID/CB_SID/CB_SKEY/CB_PROXY_AUTH 后运行。
#  详见 LOCAL_RUN.md。
# ============================================================
set -a
[ -f "$(dirname "$0")/.env.local" ] && source "$(dirname "$0")/.env.local"
set +a

: "${CB_ENV_ID:?请在 .env.local 或环境变量中设置 CB_ENV_ID}"
: "${CB_SID:?请设置 CB_SID}"
: "${CB_SKEY:?请设置 CB_SKEY}"
: "${CB_PROXY_AUTH:?请设置 CB_PROXY_AUTH}"

export LISTEN="${LISTEN:-127.0.0.1}"
export MAX_CONCURRENCY="${MAX_CONCURRENCY:-4}"

NODE="${NODE:-node}"
exec "$NODE" "$(dirname "$0")/hermes_proxy_server_v5.js"
