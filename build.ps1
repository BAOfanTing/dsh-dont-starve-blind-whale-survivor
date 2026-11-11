# 重新生成插件页的配置卡片（lib/client.js），然后跑一遍测试
# 改过 lib/index.js 里的 Config（加/减设置项）以后必须跑这个
# 用法：powershell -ExecutionPolicy Bypass -File build.ps1
. "$PSScriptRoot\common.ps1"

$node = Get-NodeExe
$repo = Get-RepoRoot
Set-Location $repo
$env:NODE_ENV = 'development'

Write-Host "生成 lib/client.js …"
& $node tools/build-client.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "跑测试 …"
& $node --test --test-force-exit 'tests/*.test.mjs'
exit $LASTEXITCODE
