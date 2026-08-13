@echo off
chcp 65001 >nul
REM ============================================================
REM  hy3-gateway 本地启动脚本（模板，不含凭据）
REM  复制本文件为 start_local_gateway.cmd（该名已被 .gitignore 忽略）
REM  然后二选一填值：
REM     A. 新建 .env.local（复制自 .env.example）并填写真实值 —— 本脚本自动读取；
REM     B. 或把下面的占位符直接改成真实值。
REM  详见 LOCAL_RUN.md。
REM ============================================================
if exist .env.local (
  for /f "usebackq tokens=1,* delims==" %%a in (.env.local) do set "%%a=%%b"
)
if not defined CB_ENV_ID set CB_ENV_ID=你的_ENV_ID
if not defined CB_SID set CB_SID=你的_SECRET_ID
if not defined CB_SKEY set CB_SKEY=你的_SECRET_KEY
if not defined CB_PROXY_AUTH set CB_PROXY_AUTH=你的_PROXY_AUTH_TOKEN
if not defined LISTEN set LISTEN=127.0.0.1
if not defined MAX_CONCURRENCY set MAX_CONCURRENCY=4
REM node 需在 PATH 中；否则改成绝对路径，例如：
REM "C:\Users\dongxiaotong\.workbuddy\binaries\node\versions\22.22.2\node.exe"
node "%~dp0hermes_proxy_server_v5.js"
