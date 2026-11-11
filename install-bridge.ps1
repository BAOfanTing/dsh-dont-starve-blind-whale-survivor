# 装 Phase 1 Bridge 的依赖并编译（改完 TS 以后也跑这个）
# 用法：powershell -ExecutionPolicy Bypass -File install-bridge.ps1
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$bridge = Join-Path $repo 'bridge'

if (-not (Test-Path $bridge)) { throw "找不到 bridge 目录：$bridge" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node（需要 Node.js 20 以上）' }

Push-Location $bridge
try {
    $env:NODE_ENV = 'development'
    if (-not (Test-Path 'node_modules')) {
        Write-Host '安装依赖（ajv / typescript / @types/node）…'
        & npm install --no-fund --no-audit --include=dev
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    }
    Write-Host '编译 TypeScript…'
    & npx tsc -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'tsc 编译失败' }
    Write-Host '跑单元测试…'
    & node --test 'dist/test/*.test.js'
    exit $LASTEXITCODE
} finally { Pop-Location }