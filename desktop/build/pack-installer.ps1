# 把绿色版目录打成一个「单文件安装器」exe：
#   exe = 安装器程序（csc 编译）+ Deflate 压缩的负载 + 16 字节页脚
# 安装时直接解压到安装目录，全程不使用 %TEMP%（这是为了绕开 NSIS 在部分机器上报
# "Error writing temporary file" 的问题）。
#
#   powershell -ExecutionPolicy Bypass -File build\pack-installer.ps1 `
#       -SourceDir "dist\Stronghold Protocol" -OutFile "dist-installer\Stronghold-Protocol-Setup-0.3.0.exe"

param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Icon = '',
  [switch]$KeepStaging,
  [switch]$Sign
)

$ErrorActionPreference = 'Stop'
$client = Split-Path -Parent $PSScriptRoot
if (-not $Icon) { $Icon = Join-Path $client 'icon.ico' }
$work = Join-Path $client '.build-installer'
$staging = Join-Path $work 'staging'

$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe', 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $csc) { throw '找不到 csc.exe（.NET Framework 4.0+ 自带），无法编译安装器。' }

function Write-Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

# --- 1. 编译 ----------------------------------------------------------------
Write-Step '编译安装器 / 卸载器'
New-Item -ItemType Directory -Force -Path $work | Out-Null
# 源码要以 UTF-8 BOM 存，csc 才会按 UTF-8 读（否则中文变乱码）
foreach ($f in @('installer\Installer.cs', 'installer\Uninstaller.cs')) {
  $p = Join-Path $client $f
  $t = [IO.File]::ReadAllText($p, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($true))
}
$stub = Join-Path $work 'Setup-stub.exe'
$uninst = Join-Path $work 'uninstall.exe'
& $csc /nologo /codepage:65001 /target:winexe "/win32icon:$Icon" "/out:$stub" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $client 'installer\Installer.cs') 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { throw '编译安装器失败' }
& $csc /nologo /codepage:65001 /target:exe "/win32icon:$Icon" "/out:$uninst" `
  (Join-Path $client 'installer\Uninstaller.cs') 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { throw '编译卸载器失败' }
Write-Host ("stub {0:N0} KB  uninstall {1:N0} KB" -f ((Get-Item $stub).Length / 1KB), ((Get-Item $uninst).Length / 1KB))

# --- 2. 组装负载目录 ---------------------------------------------------------
Write-Step "组装负载：$SourceDir"
if (-not (Test-Path $SourceDir)) { throw "找不到源目录 $SourceDir" }
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
robocopy $SourceDir $staging /E /XD userdata /XF smoke-result.json /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制负载失败（robocopy $LASTEXITCODE）" }
Copy-Item $uninst (Join-Path $staging 'uninstall.exe') -Force

$files = Get-ChildItem $staging -Recurse -File | Sort-Object FullName
$raw = ($files | Measure-Object Length -Sum).Sum
Write-Host ("负载 {0:N0} 个文件，{1:N0} MB" -f $files.Count, ($raw / 1MB))

# --- 3. 打包（Deflate 流 + 页脚） --------------------------------------------
Write-Step '压缩并写出 exe'
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$tmpOut = "$OutFile.part"
if (Test-Path $tmpOut) { Remove-Item $tmpOut -Force }
Copy-Item $stub $tmpOut -Force
$offset = (Get-Item $tmpOut).Length

$sw = [Diagnostics.Stopwatch]::StartNew()
$outFs = [IO.File]::Open($tmpOut, [IO.FileMode]::Append, [IO.FileAccess]::Write)
try {
  $deflate = New-Object System.IO.Compression.DeflateStream($outFs, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $bw = New-Object System.IO.BinaryWriter($deflate)
  $done = 0
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($staging.Length + 1).Replace('\', '/')
    $nameBytes = [Text.Encoding]::UTF8.GetBytes($rel)
    $bw.Write([int]$nameBytes.Length)
    $bw.Write($nameBytes)
    $bw.Write([long]$f.Length)
    $in = [IO.File]::OpenRead($f.FullName)
    try {
      $buf = New-Object byte[] (256 * 1024)
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $bw.Write($buf, 0, $n) }
    } finally { $in.Dispose() }
    $done++
    if ($done % 2000 -eq 0) { Write-Host ("  {0:N0} / {1:N0}" -f $done, $files.Count) }
  }
  $bw.Flush()
  $deflate.Dispose()
  # 页脚：8 字节魔数 + int64 负载偏移 + int64 未压缩总字节数（安装器用它显示"预计占用"）
  $footer = [Text.Encoding]::ASCII.GetBytes('SPPKG001') + [BitConverter]::GetBytes([long]$offset) + [BitConverter]::GetBytes([long]$raw)
  $outFs.Write($footer, 0, $footer.Length)
} finally { $outFs.Dispose() }
$sw.Stop()

if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Move-Item $tmpOut $OutFile
Write-Host ("输出：{0}  {1:N0} MB（未压缩 {2:N0} MB，用时 {3:N0} 秒）" -f $OutFile, ((Get-Item $OutFile).Length / 1MB), ($raw / 1MB), $sw.Elapsed.TotalSeconds)
if (-not $KeepStaging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }

# 可选：打完包直接签名（签名必须在打包之后——负载一变签名就失效）
if ($Sign) {
  $signScript = Join-Path $PSScriptRoot 'sign-installers.ps1'
  Write-Step '签名'
  try {
    & $signScript -Files $OutFile
    $st = (Get-AuthenticodeSignature -FilePath $OutFile).Status
    if ($st -ne 'Valid' -and $st -ne 'UnknownError') { Write-Warning "签名状态：$st（安装包本身仍可用）" }
  } catch {
    Write-Warning ("签名失败：" + $_.Exception.Message + "（安装包本身仍可用）")
  }
}
