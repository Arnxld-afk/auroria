
$ErrorActionPreference = 'Stop'
$sdk = $env:AURORIA_SDK
try {
$src = $env:AURORIA_HOST_CS
# Compiling this C# costs ~0.5 s on every start (two csc runs). Compile once per source version and load the cached assembly after that.
$sha = [System.Security.Cryptography.SHA1]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src)) | ForEach-Object { $_.ToString('x2') })
New-Item -ItemType Directory -Force -Path $env:AURORIA_CACHE | Out-Null
$dll = Join-Path $env:AURORIA_CACHE ('host-' + $hash.Substring(0, 12) + '.dll')
if (-not (Test-Path $dll)) {
  $tmp = $dll + '.tmp'
  Add-Type -IgnoreWarnings -ReferencedAssemblies System.Windows.Forms, System.Drawing, (Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $sdk 'Microsoft.Web.WebView2.WinForms.dll') -TypeDefinition $src -OutputAssembly $tmp
  Move-Item -Force $tmp $dll
}
Add-Type -Path $dll
[AuroriaResolver]::Install($sdk)
} catch { [Console]::Out.WriteLine('FAIL ' + ($_.Exception.Message -replace '\s+', ' ')); [Console]::Out.Flush(); exit 2 }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
[AuroriaHost]::Run($env:AURORIA_URL, $env:AURORIA_PROFILE, $env:AURORIA_ICON, $sdk)
