# 启动 Phase 2 Game Bridge（M1）
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1
#   powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1 -Port 18788 -Token "你的token"
# 注意：默认端口 8788 若被别的程序占用，会直接报错退出（不会偷偷换端口）。
param(
    [int]$Port = 8788,
    [string]$Token = ''
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$dir = Join-Path $repo 'game-bridge'

if (-not (Test-Path (Join-Path $dir 'dist\src\index.js'))) {
    Write-Host '还没编译，先跑 install-game-bridge.ps1 …'
    & (Join-Path $repo 'install-game-bridge.ps1')
    if ($LASTEXITCODE -ne 0) { throw '编译失败' }
}

$env:BWS_PORT = "$Port"
if ($Token) { $env:BWS_TOKEN = $Token }

Write-Host "Game Bridge 端口 $Port；健康检查 http://127.0.0.1:$Port/health"
Push-Location $dir
try { & node 'dist/src/index.js' } finally { Pop-Location }