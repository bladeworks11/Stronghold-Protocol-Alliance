# 给 exe 打 Authenticode 签名（代码签名）。
#
#   powershell -ExecutionPolicy Bypass -File build\sign-installers.ps1 -Files "dist-installer\*.exe"
#   powershell -ExecutionPolicy Bypass -File build\sign-installers.ps1 -Files "..." -Pfx "signing\stronghold-codesign.pfx" -PfxPassword "Stronghold-2026"
#
# 默认用当前用户证书库里 CN=Stronghold Protocol 的那张自签名证书（build\make-cert.ps1 生成）。
# 换成正式证书时：把 -Pfx / -PfxPassword 指向 CA 给你的 .pfx（或改用 signtool + 硬件 token），其余不变。
#
# 注意：签名必须**在打包之后**做（负载一变，签名就失效）。pack-installer.ps1 的 -Sign 会自动调用本脚本。

param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [string]$Subject = 'CN=Stronghold Protocol',
  [string]$Pfx = '',
  [string]$PfxPassword = '',
  [string]$TimestampServer = ''
)

$ErrorActionPreference = 'Stop'

function Get-SigningCert {
  if ($Pfx) {
    $pwd = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $pwd, 'Exportable,PersistKeySet')
  }
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -like "*$Subject*" -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $cert) { throw "证书库里没有可用的代码签名证书（$Subject）。先跑 build\make-cert.ps1 生成，或提供 -Pfx。" }
  return $cert
}

$cert = Get-SigningCert
Write-Host ("签名证书：" + $cert.Subject + "  到期 " + $cert.NotAfter.ToString('yyyy-MM-dd'))

# 兼容 `powershell -File ... -Files "a.exe,b.exe"`（-File 不会把逗号拆成数组）
$list = @()
foreach ($f in $Files) { $list += ($f -split ',') }
$list = $list | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$targets = @()
foreach ($f in $list) { $targets += (Get-ChildItem $f -ErrorAction SilentlyContinue) }
if (-not $targets) { throw "没有匹配到文件：$Files" }

$failed = 0
foreach ($t in $targets) {
  $params = @{ FilePath = $t.FullName; Certificate = $cert; HashAlgorithm = 'SHA256' }
  if ($TimestampServer) { $params.TimestampServer = $TimestampServer }
  try {
    $r = Set-AuthenticodeSignature @params
    $check = Get-AuthenticodeSignature -FilePath $t.FullName
    $state = if ($check.Status -eq 'Valid') { 'Valid' } elseif ($check.Status -eq 'UnknownError') { 'UnknownError（签发链不被信任：本机需先装根证书）' } else { "$($check.Status)" }
    Write-Host ("  {0,-52} {1,7:N0} MB  → {2}" -f $t.Name, ($t.Length / 1MB), $state)
  } catch {
    $failed++
    Write-Warning ("  " + $t.Name + " 签名失败：" + $_.Exception.Message)
  }
}

Write-Host ''
if ($failed -eq 0) { Write-Host '全部签名完成。' -ForegroundColor Green }
else { Write-Host "$failed 个文件签名失败。" -ForegroundColor Yellow }
if ($failed -ne 0) { exit 1 }
