# screenshot.ps1 - 截取主屏幕并保存 PNG
# 用法: powershell -ExecutionPolicy Bypass -File C:/Temp/tools/screenshot.ps1 [-Path C:/Temp/screen.png] [-Region x,y,w,h]
param(
  [string]$Path = 'C:/Temp/screen.png',
  [string]$Region = ''   # 可选：x,y,width,height 截取区域
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
  if ($Region) {
    $p = $Region.Split(','); $x=[int]$p[0]; $y=[int]$p[1]; $w=[int]$p[2]; $h=[int]$p[3]
    $bounds = New-Object System.Drawing.Rectangle($x,$y,$w,$h)
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  }
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $dir = Split-Path $Path -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $size = (Get-Item $Path).Length
  Write-Output ("screenshot saved: {0} ({1} bytes, {2}x{3})" -f $Path, $size, $bounds.Width, $bounds.Height)
  Write-Output ("[IMG]{0}[/IMG]" -f $Path)
} catch {
  Write-Output ("SCREENSHOT ERROR: {0}" -f $_.Exception.Message)
  exit 1
}
