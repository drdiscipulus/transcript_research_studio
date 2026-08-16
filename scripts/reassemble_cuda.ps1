param(
    [string]$ManifestPath = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

if (-not $ManifestPath) {
    $manifests = @(Get-ChildItem -LiteralPath $scriptRoot -Filter "*_windows_x64_cuda_portable.zip.parts.json" -File)
    if ($manifests.Count -ne 1) {
        throw "Expected exactly one CUDA parts manifest next to this script."
    }
    $ManifestPath = $manifests[0].FullName
}

$manifestFullPath = [System.IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-Path -LiteralPath $manifestFullPath -PathType Leaf)) {
    throw "CUDA parts manifest was not found: $manifestFullPath"
}
$manifestDirectory = [System.IO.Path]::GetDirectoryName($manifestFullPath)
$manifest = Get-Content -LiteralPath $manifestFullPath -Raw | ConvertFrom-Json
if ([int]$manifest.schema_version -ne 1) {
    throw "Unsupported CUDA parts manifest schema version."
}

$archiveName = [string]$manifest.archive_name
if (
    -not $archiveName -or
    [System.IO.Path]::GetFileName($archiveName) -ne $archiveName -or
    -not $archiveName.EndsWith("_windows_x64_cuda_portable.zip", [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "The manifest archive_name is invalid."
}

if (-not $OutputPath) {
    $OutputPath = Join-Path $manifestDirectory $archiveName
}
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputParent = [System.IO.Path]::GetDirectoryName($outputFullPath)
if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($outputParent, $manifestDirectory)) {
    throw "The reconstructed archive must be written next to its manifest and parts."
}
if ([System.IO.Path]::GetFileName($outputFullPath) -ne $archiveName) {
    throw "The output filename must match archive_name from the manifest."
}
if (Test-Path -LiteralPath $outputFullPath) {
    throw "Refusing to overwrite an existing reconstructed archive: $outputFullPath"
}

$archiveSize = [int64]$manifest.archive_size_bytes
$archiveHash = ([string]$manifest.archive_sha256).ToLowerInvariant()
$partSizeLimit = [int64]$manifest.part_size_limit_bytes
$parts = @($manifest.parts)
if ($archiveSize -le 0 -or $partSizeLimit -le 0 -or $archiveHash -notmatch '^[a-f0-9]{64}$' -or $parts.Count -eq 0) {
    throw "The CUDA parts manifest has invalid archive metadata."
}

$validatedParts = @()
$declaredTotal = [int64]0
for ($index = 0; $index -lt $parts.Count; $index += 1) {
    $part = $parts[$index]
    $partName = [string]$part.file_name
    $expectedPartName = "$archiveName.part$('{0:D3}' -f ($index + 1))"
    $declaredSize = [int64]$part.size_bytes
    $declaredHash = ([string]$part.sha256).ToLowerInvariant()
    if (
        $partName -ne $expectedPartName -or
        [System.IO.Path]::GetFileName($partName) -ne $partName -or
        $declaredSize -le 0 -or
        $declaredSize -gt $partSizeLimit -or
        $declaredHash -notmatch '^[a-f0-9]{64}$'
    ) {
        throw "Invalid metadata for CUDA archive part $($index + 1)."
    }

    $partPath = [System.IO.Path]::GetFullPath((Join-Path $manifestDirectory $partName))
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetDirectoryName($partPath), $manifestDirectory)) {
        throw "CUDA archive part escapes the manifest directory: $partName"
    }
    if (-not (Test-Path -LiteralPath $partPath -PathType Leaf)) {
        throw "CUDA archive part is missing: $partName"
    }
    $actualSize = (Get-Item -LiteralPath $partPath).Length
    if ($actualSize -ne $declaredSize) {
        throw "Size mismatch for $partName."
    }
    $actualHash = Get-Sha256Hex $partPath
    if ($actualHash -ne $declaredHash) {
        throw "Checksum mismatch for $partName."
    }
    $declaredTotal += $declaredSize
    $validatedParts += [PSCustomObject]@{ Path = $partPath; Name = $partName; Size = $declaredSize }
}
if ($declaredTotal -ne $archiveSize) {
    throw "The declared CUDA part sizes do not add up to the archive size."
}

$temporaryPath = Join-Path $manifestDirectory (".cuda-reassembly-" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
try {
    $output = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        foreach ($part in $validatedParts) {
            $input = [System.IO.File]::Open($part.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            try {
                $input.CopyTo($output)
            } finally {
                $input.Dispose()
            }
        }
        $output.Flush($true)
    } finally {
        $output.Dispose()
    }

    if ((Get-Item -LiteralPath $temporaryPath).Length -ne $archiveSize) {
        throw "Reassembled archive size mismatch."
    }
    $actualArchiveHash = Get-Sha256Hex $temporaryPath
    if ($actualArchiveHash -ne $archiveHash) {
        throw "Reassembled archive checksum mismatch."
    }
    Move-Item -LiteralPath $temporaryPath -Destination $outputFullPath
} finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-Output "Reassembled and verified $outputFullPath"
