# 生成一张自签名「代码签名」证书（3 年有效），顺便导出 .cer（公开）和 .pfx（含私钥，用于签名/迁移）。
#
#   powershell -ExecutionPolicy Bypass -File build\make-cert.ps1
#
# 说明：自签名证书只在「装了这张证书的机器」上显示为有效签名；
# 要发给朋友也不报警，得买正式的代码签名证书（CA 签发）。详见 README 的「签名」一节。

param(
  [string]$Subject = 'CN=Stronghold Protocol, O=Stronghold Protocol (fan project), C=CN',
  [int]$Years = 3,
  [string]$PfxPassword = 'Stronghold-2026'
)

$ErrorActionPreference = 'Stop'
$client = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $client 'signing'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -like '*Stronghold Protocol*' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
if ($existing) {
  Write-Host ("复用现有证书：" + $existing.Subject + "  指纹 " + $existing.Thumbprint)
  $cert = $existing
} else {
  Write-Host '生成新证书…'
  $cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject $Subject -CertStoreLocation Cert:\CurrentUser\My `
    -HashAlgorithm SHA256 -KeyLength 3072 -NotAfter (Get-Date).AddYears($Years) `
    -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
  Write-Host ("已生成：" + $cert.Subject + "  指纹 " + $cert.Thumbprint)
}

$cer = Join-Path $outDir 'stronghold-codesign.cer'
$pfx = Join-Path $outDir 'stronghold-codesign.pfx'
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
$sec = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $sec | Out-Null

Write-Host ''
Write-Host ("公开证书：" + $cer)
Write-Host ("含私钥的 pfx：" + $pfx + "（口令 " + $PfxPassword + "，别外传）")
Write-Host '本机信任它（装到「受信任的根」+「受信任的发布者」）：'
Write-Host ('  certutil -user -addstore Root "' + $cer + '"')
Write-Host ('  certutil -user -addstore TrustedPublisher "' + $cer + '"')
Write-Host ''
