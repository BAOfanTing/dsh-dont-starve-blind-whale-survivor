# 跑测试（不需要打开游戏）：文件桥、MCP 服务器、设置、装模组、Lua 语法和 json
# 用法：powershell -ExecutionPolicy Bypass -File test.ps1
. "$PSScriptRoot\common.ps1"

$node = Get-NodeExe
$repo = Get-RepoRoot
Set-Location $repo

$env:NODE_ENV = 'development'   # 有的机器把 NODE_ENV 设成 production，会跳过 devDependencies
Push-Location $repo
try {
    if (-not (Test-Path 'node_modules\fengari') -or -not (Test-Path 'node_modules\luaparse')) {
        Write-Host "先装一下测试用的依赖（fengari、luaparse）…"
        & npm install --no-fund --no-audit --include=dev --save-dev fengari luaparse
    }
    & $node --test --test-force-exit 'tests/*.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
