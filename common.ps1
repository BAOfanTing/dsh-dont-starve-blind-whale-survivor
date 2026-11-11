# scripts 共用：找 node、找饥荒
$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    return $PSScriptRoot
}

function Get-NodeExe {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "找不到 node。装一个 Node.js（18 以上）再加到 PATH 里。"
    }
    return $node.Source
}

function Get-DstDir {
    if ($env:DST_PATH -and (Test-Path $env:DST_PATH)) { return $env:DST_PATH }

    $candidates = @()
    # Steam 的库目录：先看常见的，再读 libraryfolders.vdf
    $steamRoots = @(
        'C:\Program Files (x86)\Steam',
        'C:\Program Files\Steam',
        'D:\Steam', 'E:\Steam', 'F:\Steam',
        'D:\SteamLibrary', 'E:\SteamLibrary', 'F:\SteamLibrary'
    )
    foreach ($root in $steamRoots) {
        if (-not (Test-Path $root)) { continue }
        $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
        if (Test-Path $vdf) {
            $common = Join-Path $root 'steamapps\common'
            $candidates += $common
            foreach ($line in (Get-Content $vdf)) {
                if ($line -match '"path"\s+"([^"]+)"') {
                    $candidates += (Join-Path ($Matches[1] -replace '\\\\', '\') 'steamapps\common')
                }
            }
        }
    }
    $candidates += @('C:\GOG Games', 'D:\GOG Games', 'E:\GOG Games')
    foreach ($common in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $common)) { continue }
        foreach ($name in @("Don't Starve Together", 'Dont Starve Together')) {
            $dir = Join-Path $common $name
            if (Test-Path (Join-Path $dir 'mods')) { return $dir }
        }
    }
    return $null
}
