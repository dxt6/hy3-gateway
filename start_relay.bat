@echo off
chcp 65001 >nul
REM 本地 AI 网关代理一键启动
set PORT=58046
set MAX_CONCURRENCY=5
set MODEL=hy3
set APIKEY_FILE=%~dp0apikey.txt
set NODE_PATH=%~dp0node_modules
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897

"%~dp0..\..\.workbuddy\binaries\node\versions\22.22.2\node.exe" "%~dp0relay.js"
pause
