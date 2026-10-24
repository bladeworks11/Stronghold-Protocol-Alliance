# 绿色版「安装到本机」：不经过 NSIS、不写 %TEMP%，被杀软拦掉安装包的机器也能用。
#   INSTALL.bat → 本脚本
# 做完：复制到 %LOCALAPPDATA%\Programs\Stronghold Protocol，建桌面/开始菜单快捷方式（带 --no-sandbox），
#       在「应用和功能」里登记，并放一个 UNINSTALL.bat 用于卸载。

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$name = '卫戍协议：盟约'
$exeName = 'Stronghold Protocol.exe'
$dst = Join-Path $env:LOCALAPPDATA 'Programs\Stronghold Protocol'
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol'

function Say($m) { Write-Host $m }

Say ''
Say '  卫戍协议：盟约 · 安装到本机'
Say '  ----------------------------------------'
if (-not (Test-Path (Join-Path $src $exeName))) { Say '  [错误] 找不到 Stronghold Protocol.exe，请把本脚本放在客户端文件夹里运行。'; exit 1 }
if (Test-Path $dst) {
  Say "  目标目录已存在：$dst"
  $ans = Read-Host '  覆盖安装？(Y/n)'
  if ($ans -and $ans.Trim().ToLower() -ne 'y') { Say '  已取消。'; exit 0 }
  Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
}

Say "  复制到 $dst …"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
# 不带上一次运行的缓存（userdata），其余全拷
robocopy $src $dst /E /XD userdata /XF install-local.ps1 INSTALL.bat /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Say "  [错误] 复制失败（robocopy $LASTEXITCODE）"; exit 1 }

# 卸载脚本随安装目录一起放
$uninst = @'
@echo off
chcp 65001 >nul
echo.
echo   卸载 卫戍协议：盟约
echo   ----------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = Split-Path -Parent '%~f0'; Remove-Item \"$env:USERPROFILE\Desktop\卫戍协议：盟约.lnk\" -Force -ErrorAction SilentlyContinue; Remove-Item \"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\卫戍协议：盟约\" -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item \"$env:LOCALAPPDATA\Programs\Stronghold Protocol\" -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '  已卸载（设置与缓存已一并删除）'"
pause
'@
Set-Content (Join-Path $dst 'UNINSTALL.bat') $uninst -Encoding ASCII

# 快捷方式（都带 --no-sandbox）
# 快捷方式图标用 exe 本身（图标已写进 exe 资源；指向独立 .ico 在部分机器上会显示成白纸）
$icon = Join-Path $dst $exeName
$exe = Join-Path $dst $exeName
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$name\$name.lnk")
)
foreach ($lnk in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lnk) | Out-Null
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $exe
  $sc.Arguments = '--no-sandbox'
  $sc.WorkingDirectory = $dst
  $sc.IconLocation = "$icon,0"
  $sc.Description = $name
  $sc.Save()
}
$scU = $shell.CreateShortcut((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$name\卸载 $name.lnk"))
$scU.TargetPath = Join-Path $dst 'UNINSTALL.bat'
$scU.Save()

# 「应用和功能」里的条目
New-Item -Path $regKey -Force | Out-Null
$ver = '0.3.0'
try { $ver = (Get-Content (Join-Path $dst 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
Set-ItemProperty -Path $regKey -Name DisplayName -Value $name
Set-ItemProperty -Path $regKey -Name DisplayVersion -Value $ver
Set-ItemProperty -Path $regKey -Name Publisher -Value 'Stronghold Protocol (fan project)'
Set-ItemProperty -Path $regKey -Name DisplayIcon -Value $icon
Set-ItemProperty -Path $regKey -Name InstallLocation -Value $dst
Set-ItemProperty -Path $regKey -Name UninstallString -Value ('"' + (Join-Path $dst 'UNINSTALL.bat') + '"')
Set-ItemProperty -Path $regKey -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $regKey -Name NoRepair -Value 1 -Type DWord

Say ''
Say '  安装完成 ✅'
Say "  位置：$dst"
Say '  桌面和开始菜单都建了快捷方式；卸载用开始菜单里的「卸载 卫戍协议：盟约」或安装目录里的 UNINSTALL.bat。'
Say ''
