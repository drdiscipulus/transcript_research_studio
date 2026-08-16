param(
    [string]$UvPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $UvPath) {
    $UvPath = Join-Path $repoRoot ".venv\Scripts\uv.exe"
}
if (-not (Test-Path -LiteralPath $UvPath -PathType Leaf)) {
    throw "uv was not found at $UvPath. Install uv 0.8.22 in the project venv first."
}

$source = Join-Path $repoRoot "requirements-runtime.in"
$profiles = @(
    @{
        Name = "Windows CPU"
        Platform = "x86_64-pc-windows-msvc"
        TorchBackend = "cpu"
        OnlyBinary = $true
        Output = "requirements-win-cpu.txt"
    },
    @{
        Name = "Windows CUDA 12.8"
        Platform = "x86_64-pc-windows-msvc"
        TorchBackend = "cu128"
        OnlyBinary = $true
        Output = "requirements-win-gpu.txt"
    },
    @{
        Name = "macOS Apple Silicon CPU"
        Platform = "aarch64-apple-darwin"
        TorchBackend = "cpu"
        OnlyBinary = $false
        Output = "requirements-macos-cpu.txt"
    }
)

foreach ($profile in $profiles) {
    $output = Join-Path $repoRoot $profile.Output
    Write-Host "Compiling $($profile.Name) lock -> $($profile.Output)"
    $compileArgs = @(
        "pip", "compile", $source,
        "--python-version", "3.12",
        "--python-platform", $profile.Platform,
        "--torch-backend", $profile.TorchBackend,
        "--generate-hashes",
        "--emit-index-url",
        "--quiet",
        "--no-annotate",
        "--custom-compile-command", "scripts/compile_runtime_locks.ps1",
        "--output-file", $output
    )
    if ($profile.OnlyBinary) {
        $compileArgs += @("--only-binary", ":all:")
    }
    & $UvPath @compileArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Lock compilation failed for $($profile.Name)."
    }
}

Write-Host "All runtime locks compiled successfully."
