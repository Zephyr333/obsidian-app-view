$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
function Get-Sha256([string] $Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
}
Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    $manifest = Get-Content -LiteralPath 'manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne $package.version) { throw 'Version mismatch.' }
    $zipPath = Join-Path $projectRoot "dist/app-view-$($manifest.version).zip"
    Compress-Archive -LiteralPath (Join-Path $projectRoot 'dist/app-view') -DestinationPath $zipPath -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entries = @($archive.Entries | Where-Object { $_.Name })
        $names = @($entries | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
        if (($names -join ',') -ne 'app-view/main.js,app-view/manifest.json,app-view/styles.css') { throw "Unexpected archive contents: $names" }
        foreach ($entry in $entries) {
            $stream = $entry.Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose(); $sha.Dispose() }
            $localHash = Get-Sha256 (Join-Path $projectRoot "dist/app-view/$($entry.Name)")
            if ($hash -ne $localHash) { throw "Archive checksum mismatch: $($entry.Name)" }
        }
    } finally { $archive.Dispose() }
    $lines = foreach ($name in @('app-view/main.js', 'app-view/manifest.json', 'app-view/styles.css', "app-view-$($manifest.version).zip")) {
        $hash = (Get-Sha256 (Join-Path $projectRoot "dist/$name")).ToLowerInvariant()
        "$hash  $name"
    }
    [System.IO.File]::WriteAllLines((Join-Path $projectRoot 'dist/SHA256SUMS.txt'), $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Output "Verified package: $zipPath"
} finally { Pop-Location }
