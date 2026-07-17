$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$destRoot = Join-Path $repoRoot 'src-tauri\resources\bundled-runtime\windows'
$destCli = Join-Path $destRoot 'npm-global'
$destGit = Join-Path $destRoot 'git'

$defaultCliSource = Join-Path $env:LOCALAPPDATA 'com.tinyzhuang.tokenicode\npm-global'
$defaultGitSource = 'C:\Program Files\Git'

function Copy-RuntimeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path $Source)) {
    throw "Source not found: $Source"
  }

  if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force

  $measure = Get-ChildItem -LiteralPath $Destination -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum
  [PSCustomObject]@{
    Path = $Destination
    Files = $measure.Count
    SizeMB = [math]::Round(($measure.Sum / 1MB), 2)
  }
}

New-Item -ItemType Directory -Path $destRoot -Force | Out-Null

$results = @()
$results += Copy-RuntimeDirectory -Source $defaultCliSource -Destination $destCli

if (Test-Path $defaultGitSource) {
  $results += Copy-RuntimeDirectory -Source $defaultGitSource -Destination $destGit
} else {
  Write-Warning "Git source not found, skipped: $defaultGitSource"
}

$manifest = [ordered]@{
  generatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
  cliSource = $defaultCliSource
  gitSource = if (Test-Path $defaultGitSource) { $defaultGitSource } else { $null }
  outputs = $results
}

$manifestPath = Join-Path $destRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Output ''
Write-Output 'Bundled runtime staged successfully:'
$results | Format-Table -AutoSize
Write-Output "Manifest: $manifestPath"
