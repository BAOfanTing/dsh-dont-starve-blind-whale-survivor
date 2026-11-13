# 装 Phase 2 Game Bridge 的依赖并编译 + 跑 M1 测试
# 用法：powershell -ExecutionPolicy Bypass -File install-game-bridge.ps1
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$dir = Join-Path $repo 'game-bridge'
if (-not (Test-Path $dir)) { throw "找不到 game-bridge 目录：$dir" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node（需要 Node.js 20 以上）' }

Push-Location $dir
try {
    $env:NODE_ENV = 'development'
    if (-not (Test-Path 'node_modules')) {
        Write-Host '安装依赖（typescript / @types/node）…'
        & npm install --no-fund --no-audit --include=dev
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    }
    Write-Host '编译 TypeScript…'
    & npx tsc -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'tsc 编译失败' }
    Write-Host '跑 M1 测试…'
    & node --test 'dist/test/*.test.js'
    exit $LASTEXITCODE
} finally { Pop-Location }