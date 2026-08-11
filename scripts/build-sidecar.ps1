param([string]$PythonPath = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
if (-not $PythonPath) {
    $candidates = @(
        (Join-Path $backendDir '.venv\Scripts\python.exe'),
        (Join-Path $backendDir '.codex-venv\Scripts\python.exe'),
        (Join-Path $repoRoot '.venv\Scripts\python.exe')
    )
    $PythonPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $PythonPath) { $PythonPath = 'python' }
if ($PythonPath -ne 'python' -and -not [IO.Path]::IsPathRooted($PythonPath)) {
    $PythonPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $PythonPath))
}
if ($PythonPath -ne 'python' -and -not (Test-Path -LiteralPath $PythonPath)) {
    throw "Python executable not found: $PythonPath"
}

Push-Location $backendDir
try {
    & $PythonPath -m pip install -r requirements-desktop.txt
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install desktop backend dependencies.' }
    & $PythonPath -m PyInstaller --noconfirm --clean --onefile --name riji-sidecar --collect-all uvicorn --collect-all fastapi --collect-all sqlalchemy --hidden-import aiosqlite desktop_sidecar.py
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the FastAPI sidecar.' }
    Write-Host "sidecar: $backendDir\dist\riji-sidecar.exe"
} finally {
    Pop-Location
}
