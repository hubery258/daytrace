param(
    [string]$PythonPath = "",
    [string]$ElectronMirror = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build-sidecar.ps1') -PythonPath $PythonPath

$frontendDir = Join-Path $repoRoot 'frontend'
$buildTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempOutputRelative = "../release/desktop-build-$buildTag"
$tempOutput = Join-Path $repoRoot "release\desktop-build-$buildTag"
$stableDir = Join-Path $repoRoot 'release\desktop'
$stableArtifact = Join-Path $stableDir 'riji-desktop-0.6.0.exe'
Push-Location $frontendDir
try {
    if ($ElectronMirror) { $env:ELECTRON_MIRROR = $ElectronMirror }
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install frontend dependencies.' }
    $electronExe = Join-Path $frontendDir 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronExe)) {
        node .\node_modules\electron\install.js
        if ($LASTEXITCODE -ne 0) { throw 'Failed to download Electron. Use -ElectronMirror when needed.' }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the frontend.' }
    node .\node_modules\electron-builder\cli.js --win portable --x64 --publish never "--config.directories.output=$tempOutputRelative"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the desktop portable package.' }
} finally {
    Pop-Location
}

$builtArtifact = Join-Path $tempOutput 'riji-desktop-0.6.0.exe'
if (-not (Test-Path -LiteralPath $builtArtifact)) { throw "Missing desktop artifact: $builtArtifact" }
New-Item -ItemType Directory -Path $stableDir -Force | Out-Null
Copy-Item -LiteralPath $builtArtifact -Destination $stableArtifact -Force
Write-Host "desktop: $stableArtifact"
