param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts'))
$ErrorActionPreference = 'Stop'
$assistOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $assistOutput -Force | Out-Null
Push-Location (Join-Path $PSScriptRoot '..\agent\windows')
try {
  go test ./...
  if ($LASTEXITCODE -ne 0) { throw 'Agent tests failed' }
  $assistExe = Join-Path $assistOutput 'chloe-assist.exe'
  go build -trimpath -ldflags '-H=windowsgui -s -w' -o $assistExe .
  if ($LASTEXITCODE -ne 0) { throw 'Assist build failed' }
  $assistHash = (Get-FileHash -LiteralPath $assistExe -Algorithm SHA256).Hash.ToLowerInvariant()
  "$assistHash  chloe-assist.exe" | Set-Content -LiteralPath (Join-Path $assistOutput 'SHA256SUMS.txt') -Encoding ascii
  [pscustomobject]@{Executable=$assistExe;Bytes=(Get-Item -LiteralPath $assistExe).Length;SHA256=$assistHash;Signature=(Get-AuthenticodeSignature -LiteralPath $assistExe).Status}
} finally { Pop-Location }
