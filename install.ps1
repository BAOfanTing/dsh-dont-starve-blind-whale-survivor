# 把饥荒模组装进游戏的 mods 目录（平时不用手动跑：DSH 插件会自动装）
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 "E:\SteamLibrary\steamapps\common\Don't Starve Together"
. "$PSScriptRoot\common.ps1"

$node = Get-NodeExe
$repo = Get-RepoRoot
$game = $args[0]
if (-not $game -and $env:DST_PATH) { $game = $env:DST_PATH }

$installer = Join-Path $repo 'tools\install-mod.mjs'
if ($game) {
    Write-Host "游戏目录：$game"
    & $node $installer $game
} else {
    Write-Host "自动找游戏目录…"
    & $node $installer
}
exit $LASTEXITCODE
