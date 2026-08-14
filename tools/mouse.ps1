# mouse.ps1 - 鼠标键盘控制（基于 user32）
# 用法: powershell -ExecutionPolicy Bypass -File C:/Temp/tools/mouse.ps1 <action> [参数]
#   move x y                移动鼠标到屏幕坐标
#   click x y               左键单击
#   rightclick x y          右键单击
#   doubleclick x y         左键双击
#   drag x1 y1 x2 y2        从(x1,y1)按住拖到(x2,y2)松开
#   scroll lines            滚轮（正=上滚，负=下滚）
#   type "text"             在当前焦点处输入文本（含中文，用剪贴板方式）
#   key <name>              按键（Enter/Tab/Escape/Backspace/Delete/Up/Down/Left/Right/Home/End/PageUp/PageDown/space/ctrl+c 等）
#   pos                     输出当前鼠标坐标（用于确认屏幕坐标系）
# 注意：不用 param 块——PowerShell 5.1 在 -File 模式下 param+位置数组绑定有缺陷，统一走 $args 自动变量。
$Action = if($args.Count -gt 0){ $args[0] } else { '' }
$Argv = @()
if($args.Count -gt 1){ $Argv = @($args[1..($args.Count-1)]) }
if(-not $Action){ throw 'usage: mouse.ps1 <action> [args] (move x y / click x y / rightclick x y / doubleclick x y / drag x1 y1 x2 y2 / scroll lines / type text / key name / pos)' }
$ErrorActionPreference = 'Stop'

# 压缩环境块：Add-Type 启动 C# 编译器时要求环境块 <=64KB，
# 部分环境（如 Codex/WorkBuddy 会话）会注入几十万个字节的环境变量导致编译失败。
# 用 .NET API 而非 Env: provider（后者在该环境下会报重复键）。
$__savedEnv = @{}
$__envAll = [System.Environment]::GetEnvironmentVariables()
foreach($__k in $__envAll.Keys){ $__savedEnv[$__k.ToString()] = [string]$__envAll[$__k] }
foreach($__k in @($__savedEnv.Keys)){ [System.Environment]::SetEnvironmentVariable($__k, $null, 'Process') }
foreach($__keep in @('TEMP','TMP','PATH','SystemRoot','windir')){ if($__savedEnv.ContainsKey($__keep)){ [System.Environment]::SetEnvironmentVariable($__keep, $__savedEnv[$__keep], 'Process') } }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseWin {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

# 恢复环境变量（Add-Type 只需编译一次，后续 P/Invoke 不再启动子进程）
foreach($__k in $__savedEnv.Keys){ try { [System.Environment]::SetEnvironmentVariable($__k, $__savedEnv[$__k], 'Process') } catch {} }

# VK 码表（常用）
$VK = @{
  'enter'=13; 'return'=13; 'tab'=9; 'escape'=27; 'esc'=27; 'backspace'=8; 'delete'=46;
  'up'=38; 'down'=40; 'left'=37; 'right'=39; 'home'=36; 'end'=35; 'pageup'=33; 'pagedown'=34;
  'space'=32; 'f5'=116; 'f6'=117; 'f12'=123; 'a'=65;'b'=66;'c'=67;'d'=68;'e'=69;'f'=70;'g'=71;'h'=72;'i'=73;'j'=74;'k'=75;'l'=76;'m'=77;'n'=78;'o'=79;'p'=80;'q'=81;'r'=82;'s'=83;'t'=84;'u'=85;'v'=86;'w'=87;'x'=88;'y'=89;'z'=90;
  '0'=48;'1'=49;'2'=50;'3'=51;'4'=52;'5'=53;'6'=54;'7'=55;'8'=56;'9'=57
}
$MOUSEEVENTF_LEFTDOWN=0x02; $MOUSEEVENTF_LEFTUP=0x04
$MOUSEEVENTF_RIGHTDOWN=0x08; $MOUSEEVENTF_RIGHTUP=0x10
$MOUSEEVENTF_WHEEL=0x0800; $KEYEVENTF_KEYUP=0x02

function MoveTo([int]$x,[int]$y){ [MouseWin]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 80 }
function DoClick([int]$x,[int]$y,[uint32]$down,[uint32]$up){
  MoveTo $x $y
  [MouseWin]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [MouseWin]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
function SendKey([string]$name){
  $parts = $name.ToLower().Split('+')
  $ctrl=0; $alt=0; $shift=0; $key=$parts[-1]
  foreach($p in $parts){ if($p -eq 'ctrl' -or $p -eq 'control'){$ctrl=17}; if($p -eq 'alt'){$alt=18}; if($p -eq 'shift'){$shift=16} }
  $vkc = 0
  if($VK.ContainsKey($key)){ $vkc = $VK[$key] } else { $vkc = [int][char]::ToUpper($key[0]) }
  foreach($m in @($ctrl,$alt,$shift)){ if($m -gt 0){ [MouseWin]::keybd_event([byte]$m,0,0,[UIntPtr]::Zero) } }
  [MouseWin]::keybd_event([byte]$vkc,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [MouseWin]::keybd_event([byte]$vkc,0,$KEYEVENTF_KEYUP,[UIntPtr]::Zero)
  foreach($m in @($ctrl,$alt,$shift)){ if($m -gt 0){ [MouseWin]::keybd_event([byte]$m,0,$KEYEVENTF_KEYUP,[UIntPtr]::Zero) } }
}

switch ($Action.ToLower()) {
  'pos' {
    $pt = New-Object MouseWin+POINT
    [MouseWin]::GetCursorPos([ref]$pt) | Out-Null
    Write-Output ("mouse position: {0},{1}" -f $pt.X, $pt.Y)
  }
  'move' {
    if($Argv.Count -lt 2){ throw "usage: move x y" }
    MoveTo ([int]$Argv[0]) ([int]$Argv[1])
    Write-Output ("moved to {0},{1}" -f $Argv[0], $Argv[1])
  }
  'click' {
    if($Argv.Count -lt 2){ throw "usage: click x y" }
    DoClick ([int]$Argv[0]) ([int]$Argv[1]) $MOUSEEVENTF_LEFTDOWN $MOUSEEVENTF_LEFTUP
    Write-Output ("left click at {0},{1}" -f $Argv[0], $Argv[1])
  }
  'rightclick' {
    if($Argv.Count -lt 2){ throw "usage: rightclick x y" }
    DoClick ([int]$Argv[0]) ([int]$Argv[1]) $MOUSEEVENTF_RIGHTDOWN $MOUSEEVENTF_RIGHTUP
    Write-Output ("right click at {0},{1}" -f $Argv[0], $Argv[1])
  }
  'doubleclick' {
    if($Argv.Count -lt 2){ throw "usage: doubleclick x y" }
    DoClick ([int]$Argv[0]) ([int]$Argv[1]) $MOUSEEVENTF_LEFTDOWN $MOUSEEVENTF_LEFTUP
    Start-Sleep -Milliseconds 80
    DoClick ([int]$Argv[0]) ([int]$Argv[1]) $MOUSEEVENTF_LEFTDOWN $MOUSEEVENTF_LEFTUP
    Write-Output ("double click at {0},{1}" -f $Argv[0], $Argv[1])
  }
  'drag' {
    if($Argv.Count -lt 4){ throw "usage: drag x1 y1 x2 y2" }
    MoveTo ([int]$Argv[0]) ([int]$Argv[1])
    [MouseWin]::mouse_event($MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    MoveTo ([int]$Argv[2]) ([int]$Argv[3])
    Start-Sleep -Milliseconds 80
    [MouseWin]::mouse_event($MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
    Write-Output ("dragged from {0},{1} to {2},{3}" -f $Argv[0],$Argv[1],$Argv[2],$Argv[3])
  }
  'scroll' {
    if($Argv.Count -lt 1){ throw 'usage: scroll lines(正上负下)' }
    $lines = [int]$Argv[0]
    # dwData 是有符号 delta（正=上滚负=下滚），按位模式转 UInt32 传给 mouse_event
    $bytes = [System.BitConverter]::GetBytes([int]($lines * 120))
    $dw = [System.BitConverter]::ToUInt32($bytes, 0)
    [MouseWin]::mouse_event($MOUSEEVENTF_WHEEL,0,0,$dw,[UIntPtr]::Zero)
    Write-Output ("scrolled {0} lines" -f $lines)
  }
  'type' {
    if($Argv.Count -lt 1){ throw 'usage: type "text"' }
    $text = $Argv -join ' '
    # 中文/特殊字符用剪贴板 + Ctrl+V 保证兼容
    Set-Clipboard -Value $text
    SendKey 'ctrl+v'
    Write-Output ("typed: {0}" -f $text)
  }
  'key' {
    if($Argv.Count -lt 1){ throw "usage: key <name>" }
    SendKey $Argv[0]
    Write-Output ("key pressed: {0}" -f $Argv[0])
  }
  default { throw "unknown action: $Action" }
}
