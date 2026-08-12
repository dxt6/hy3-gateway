@echo off
REM ============================================================
REM  SSH Tunnel (BACKUP option): local 8787 -> CN server 8787
REM  Only needed if you prefer remote gateway via tunnel.
REM  Primary: use local_gateway\start_local_gateway.bat instead
REM  Target: 118.24.71.189 (Aliyun Debian 13, hermes-proxy)
REM ============================================================
title SSH Tunnel 8787 (CN server backup) - keep open
echo Establishing SSH tunnel...
echo   local http://127.0.0.1:8787  ->  118.24.71.189:8787
echo Keep this window open. Closing it disconnects the tunnel.
echo.
ssh -i "%USERPROFILE%\.ssh\id_ed25519" -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 8787:127.0.0.1:8787 root@118.24.71.189
echo.
echo Tunnel closed.
pause
