# 把 client 打成可以直接发给朋友的绿色版文件夹（可选把素材一起塞进去）。
#
#   powershell -ExecutionPolicy Bypass -File build\build-portable.ps1
#   powershell -ExecutionPolicy Bypass -File build\build-portable.ps1 -WithAssets -Zip
#
# 参数：
#   -WithAssets   把 game\public\assets、public\fonts 复制进客户端（约 +930 MB），首屏不下载素材
#   -Zip          额外打一个 zip（用 bsdtar，比 Compress-Archive 快很多）
#   -GameDir      游戏目录（默认自动找 ..\Stronghold-Protocol-Server-Launcher-master*\game）
#   -OutDir       输出目录（默认 client\dist）
param(
  [switch]$WithAssets,
  [switch]$Zip,
  [string]$GameDir = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$client = Split-Path -Parent $PSScriptRoot
$name = 'Stronghold Protocol'

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }

# --- 1. 找游戏目录（要素材时才需要） ------------------------------------------------
if (-not $GameDir) {
  $candidates = Get-ChildItem (Split-Path -Parent $client) -Directory -Filter 'Stronghold-Protocol-Server-Launcher-master*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'game' } |
    Where-Object { Test-Path (Join-Path $_ 'server\index.js') } |
    Sort-Object { (Get-Item $_).LastWriteTime } -Descending
  if ($candidates) { $GameDir = $candidates[0] }
}
if ($WithAssets) {
  if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir 'public\assets'))) {
    throw "找不到带素材的游戏目录。用 -GameDir 指定（里面应有 public\assets 与 public\fonts）。"
  }
}

# --- 2. Electron 运行时 --------------------------------------------------------------
Write-Step '准备 Electron 运行时'
$electronDist = Join-Path $client 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
  Write-Warn '还没下载 Electron，正在安装（首次约 110 MB，走国内镜像）…'
  Push-Location $client
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
  Pop-Location
  if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) { throw 'Electron 运行时仍然缺失，检查网络或 npm 镜像。' }
}

# --- 3. 复制一份运行时 ----------------------------------------------------------------
$out = if ($OutDir) { $OutDir } else { Join-Path $client 'dist' }
$app = Join-Path $out $name
Write-Step "输出到 $app"
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null

Write-Host '复制 Electron …'
robocopy $electronDist $app /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 复制 Electron 失败（$LASTEXITCODE）" }
Remove-Item (Join-Path $app 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

# --- 4. 放进去本客户端 ----------------------------------------------------------------
Write-Step '放入客户端文件'
$appRes = Join-Path $app 'resources\app'
New-Item -ItemType Directory -Path $appRes -Force | Out-Null
foreach ($f in @('package.json', 'main.js', 'sync.js', 'preload.js', 'offline.html', 'config.json', 'icon.png', 'icon.ico', 'icon-256.png', 'README.md')) {
  Copy-Item (Join-Path $client $f) (Join-Path $appRes $f) -Force
}


# 绿色版自带的「安装到本机」：只做文件复制 + 快捷方式 + 注册表，不经过 NSIS、不写 %TEMP%
Copy-Item (Join-Path $client 'build\install-local.ps1') (Join-Path $app 'install-local.ps1') -Force
$installBat = "@echo off`r`nchcp 65001 >nul`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0install-local.ps1`"`r`npause`r`n"
Set-Content (Join-Path $app 'INSTALL.bat') $installBat -Encoding ASCII

# --- 5. 素材（可选） ------------------------------------------------------------------
$assetsMb = 0
if ($WithAssets) {
  Write-Step '复制素材（约 25,700 个文件 / 930 MB，需要几分钟）'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  robocopy (Join-Path $GameDir 'public\assets') (Join-Path $appRes 'assets') /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制 assets 失败（$LASTEXITCODE）" }
  robocopy (Join-Path $GameDir 'public\fonts') (Join-Path $appRes 'fonts') /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制 fonts 失败（$LASTEXITCODE）" }
  $sw.Stop()
  $assetsMb = [math]::Round(((Get-ChildItem (Join-Path $appRes 'assets') -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 0)
  Write-Host ("素材就位：{0} MB，用时 {1:N0} 秒" -f $assetsMb, $sw.Elapsed.TotalSeconds)

  # 服务器已装的插件（外观/内容/界面）：一起带走，客户端按内容哈希直接回答 /p/…，玩家不用再下
  $srcPlugins = Join-Path $GameDir 'plugins'
  if (Test-Path $srcPlugins) {
    Write-Step '复制插件（服务器已安装的 cosmetic / content / ui）'
    robocopy $srcPlugins (Join-Path $appRes 'plugins') /E /XD '_template' '_replaced' /XF '*.md' '_template' '.studio-key' /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "复制 plugins 失败（$LASTEXITCODE）" }
    $pluginMb = [math]::Round(((Get-ChildItem (Join-Path $appRes 'plugins') -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 0)
    Write-Host ("插件就位：{0} MB" -f $pluginMb)
  }

  # 包内清单：启动时的内容同步靠它判断「服务器上的文件包里已有一份一样的」，不用下载（client/sync.js）
  Write-Step '生成包内清单（bundle-index.json，约 20-60 秒）'
  $pkgVersion = ((Get-Content (Join-Path $client 'package.json') -Raw -Encoding UTF8) | ConvertFrom-Json).version
  & node (Join-Path $client 'build\make-bundle-index.mjs') `
      --assets (Join-Path $appRes 'assets') --fonts (Join-Path $appRes 'fonts') `
      --plugins (Join-Path $appRes 'plugins') --out (Join-Path $appRes 'bundle-index.json') `
      --app $pkgVersion
  if ($LASTEXITCODE -ne 0) { Write-Warn "包内清单生成失败（$LASTEXITCODE）：客户端首次启动会把包内文件各读一遍校验，不影响运行" }
}

# --- 6. 改名 + 图标/版本写进 exe + 构建信息 ---------------------------------------------
Write-Step '改名 / 写构建信息'
$exe = Join-Path $app "$name.exe"
Move-Item (Join-Path $app 'electron.exe') $exe -Force
$server = ((Get-Content (Join-Path $client 'config.json') -Raw -Encoding UTF8) | ConvertFrom-Json).server
$appVersion = ((Get-Content (Join-Path $client 'package.json') -Raw -Encoding UTF8) | ConvertFrom-Json).version

# 资源管理器/任务栏看到的图标、右键「属性」里的版本，都来自 exe 资源（直接调 rcedit 二进制，少一层转手）
$rcedit = Join-Path $client 'node_modules\rcedit\bin\rcedit-x64.exe'
if (Test-Path $rcedit) {
  $four = if ($appVersion -match '^\d+\.\d+\.\d+$') { "$appVersion.0" } else { $appVersion }
  & $rcedit $exe `
      --set-icon (Join-Path $appRes 'icon.ico') `
      --set-file-version $four --set-product-version $four `
      --set-version-string FileDescription $name `
      --set-version-string ProductName $name `
      --set-version-string CompanyName 'Stronghold Protocol (fan project)' `
      --set-version-string LegalCopyright 'GPL-3.0-or-later, game art (c) Hypergryph / Yostar' 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warn "rcedit 返回 $LASTEXITCODE：exe 图标/版本没写进去（不影响运行）" }
  else { Write-Host 'exe 图标与版本信息已写入' }
} else { Write-Warn '没装 rcedit（npm install 后会带上），跳过 exe 图标' }

@(
  "内置版本: $appVersion",
  "构建时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "服务器:   $server",
  "素材:     $(if ($WithAssets) { "已内置（$assetsMb MB）" } else { '未内置（首次从服务器下载并缓存）' })",
  "Electron: $((Get-Content (Join-Path $electronDist 'version') -ErrorAction SilentlyContinue))"
) | Set-Content (Join-Path $app 'BUILD.txt') -Encoding UTF8

# 主 exe 必须签名：这台机器的安全软件会拦未签名的新 exe（启动直接退出）；必须在改名/rcedit 之后、打包之前
Write-Step '给 Stronghold Protocol.exe 签名'
$signScript = Join-Path $client 'build\sign-installers.ps1'
$exePath = Join-Path $app "$name.exe"
if ((Test-Path $signScript) -and (Test-Path $exePath)) {
  try {
    & $signScript -Files $exePath 2>&1 | Select-Object -Last 3 | Write-Host
  } catch {
    Write-Warn ("签名失败（游戏仍可运行，但本机安全软件可能拦截）：" + $_)
  }
} else {
  Write-Warn '找不到 sign-installers.ps1 或 exe，跳过签名'
}
# --- 7. 启动入口：快捷方式（带 --no-sandbox）+ 启动.bat + 读我.txt ------------------------
$lnk = Join-Path $out "$name.lnk"
try {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $exe
  $sc.Arguments = '--no-sandbox'
  $sc.WorkingDirectory = $app
  $sc.IconLocation = (Join-Path $appRes 'icon.ico') + ',0'
  $sc.Description = '卫戍协议：盟约'
  $sc.Save()
  Write-Host "快捷方式: $lnk"
} catch { Write-Warn "快捷方式创建失败：$($_.Exception.Message)" }

# 有的机器（杀软 / 组策略）会拦掉 Chromium 的渲染沙箱：双击 exe 一闪就退。这个入口带 --no-sandbox 绕开。
$bat = "@echo off`r`nrem --no-sandbox: some antivirus/policy setups block Chromium's renderer sandbox.`r`nstart `"`" `"%~dp0$name.exe`" --no-sandbox %*`r`n"
Set-Content (Join-Path $app 'PLAY.bat') $bat -Encoding ASCII

$assetsLine = if ($WithAssets) { '已随客户端打包（约 913 MB）：进游戏不再下载素材，服务器只发代码和数据。' } else { '未随客户端打包：首次进游戏从服务器下载，之后缓存在本机。' }
$readme = @"
卫戍协议：盟约 · 桌面客户端
========================================

怎么进游戏
  双击「PLAY.bat」  —— 推荐，兼容性最好
  想「装到本机」：双击「INSTALL.bat」  —— 复制到 %LOCALAPPDATA%\Programs、建桌面/开始菜单快捷方式、
     在「应用和功能」里登记；卸载用开始菜单里的「卸载 卫戍协议：盟约」。
     这条路径不经过 NSIS、不写 %TEMP%，安装包被杀软拦掉（报 Error writing temporary file）的机器用它。
  或双击「$name.exe」
    如果 exe 一闪就没 / 完全没反应：这台机器的杀软或组策略拦掉了
    Chromium 的渲染沙箱，改用「PLAY.bat」即可（它带 --no-sandbox）。

第一次进入
  输入博士代号 → 开始 → 同盟模拟 → 创建房间 → 右上角复制链接发给朋友。

服务器
  $server
  换地址：记事本打开 resources\app\config.json，改 server 那一行，保存后重开客户端。

账号同步
  设置 → 账号同步 打开后，设置 / 编队 / 战绩按博士代号存到服务器，换设备用同一代号接上。
  客户端自己的缓存与设置在 resources\app\userdata（跟着文件夹走，删掉文件夹就连设置一起清掉）。

素材
  $assetsLine

快捷键
  F11 全屏    Ctrl+R 重载    F12 开发者工具

卸载
  删掉这个文件夹即可（想连本机缓存一起清，再删 %APPDATA%\Stronghold Protocol）。
"@
Set-Content (Join-Path $app 'README.txt') $readme -Encoding UTF8

# --- 8. 打包 zip（可选） ---------------------------------------------------------------
if ($Zip) {
  Write-Step '打 zip（约 1 GB 时可能要几分钟）'
  $zipPath = Join-Path $out "$name.zip"
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Push-Location $out
  tar -a -c -f $zipPath $name
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Warn "zip 打包失败（$code），文件夹本身已可用" }
  else { Write-Host ("zip: {0}  {1:N0} MB" -f $zipPath, ((Get-Item $zipPath).Length / 1MB)) }
}

# --- 9. 汇总 --------------------------------------------------------------------------
$total = [math]::Round(((Get-ChildItem $app -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 0)
Write-Host ''
Write-Host "完成：$exe" -ForegroundColor Green
Write-Host "总体积：$total MB（素材 $assetsMb MB）"
Write-Host "直接把这个文件夹（或 zip）发给朋友即可。"
