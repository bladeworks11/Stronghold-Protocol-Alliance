# 客户端启动稳定性自检：连续启动 N 次，每次等自检结果，统计成败与耗时。
#
#   powershell -ExecutionPolicy Bypass -File client\build\check-launch.ps1
#   powershell -ExecutionPolicy Bypass -File client\build\check-launch.ps1 -Runs 10 -Assets
#
# 说明：
#   * 用 --smoke 启动，客户端加载页面后写 smoke-result.json 并自行退出，不需要人工关窗口；
#   * 每次跑之前清掉 userData（真正冷启动），并删掉上一次的结果文件；
#   * 任何一个失败都会让脚本以退出码 1 结束，方便接到发布流程里。
param(
  [int]$Runs = 5,
  [switch]$Assets,
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$client = Split-Path -Parent $PSScriptRoot
$rel = if ($Assets) { 'dist-assets\Stronghold Protocol' } else { 'dist\Stronghold Protocol' }
$dir = Join-Path $client $rel
$exe = Join-Path $dir 'Stronghold Protocol.exe'
if (-not (Test-Path $exe)) { throw "找不到 $exe（先跑 build-portable.ps1）" }

# 这台机器的 Electron 若继承了 ELECTRON_RUN_AS_NODE 会退化成 Node 跑，启动必失败
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$res = Join-Path $dir 'smoke-result.json'
$ud = Join-Path $dir 'userdata'
$rows = @()
$fail = 0

for ($i = 1; $i -le $Runs; $i++) {
  Remove-Item $res, $ud -Recurse -Force -ErrorAction SilentlyContinue
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe -ArgumentList '--smoke', '--no-sandbox' -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not (Test-Path $res) -and (Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 250 }
  $sw.Stop()

  $ok = $false; $port = ''; $local = ''
  if (Test-Path $res) {
    $j = Get-Content $res -Raw | ConvertFrom-Json
    $ok = [bool]$j.ok; $port = $j.proxy; $local = $j.requests.local
  }
  if (-not $ok) { $fail++ }
  # 结果文件出现后客户端还会 app.exit(0)，给它 3 秒正常退出，别误报成 timeout
  $wait = (Get-Date).AddSeconds(3)
  while (-not $p.HasExited -and (Get-Date) -lt $wait) { Start-Sleep -Milliseconds 100 }
  $code = if ($p.HasExited) { $p.ExitCode } else { 'timeout' }
  if (-not $p.HasExited) { $p.Kill() }

  $rows += [pscustomobject]@{
    '# '      = $i
    结果      = if ($ok) { 'OK' } else { '失败' }
    退出码    = $code
    耗时秒    = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    端口      = ($port -replace 'http://', '')
    素材本地  = $local
  }
  Start-Sleep -Seconds 2
}

$rows | Format-Table -AutoSize
Remove-Item $res, $ud -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($fail -eq 0) {
  Write-Host ("启动自检通过：$Runs/$Runs 次成功。") -ForegroundColor Green
  exit 0
}
Write-Host ("启动自检失败：$fail/$Runs 次异常。") -ForegroundColor Red
exit 1
