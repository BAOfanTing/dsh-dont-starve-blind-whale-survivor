# 启动 Phase 1 Bridge（读饥荒日志，提供 REST 接口）
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-bridge.ps1
#   powershell -ExecutionPolicy Bypass -File start-bridge.ps1 -Port 18081 -LogDir "C:\Users\你\OneDrive\文档\Klei\DoNotStarveTogether"
param(
    [int]$Port = 18081,
    [string]$LogDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$bridge = Join-Path $repo 'bridge'

if (-not (Test-Path (Join-Path $bridge 'dist\src\index.js'))) {
    Write-Host '还没编译，先跑 install-bridge.ps1 …'
    & (Join-Path $repo 'install-bridge.ps1')
    if ($LASTEXITCODE -ne 0) { throw '编译失败' }
}

$env:BWS_PORT = "$Port"
if ($LogDir) { $env:BWS_LOG_DIR = $LogDir }

Write-Host "Bridge 端口：$Port（浏览器打开 http://127.0.0.1:$Port/health）"
Push-Location $bridge
try { & node 'dist/src/index.js' } finally { Pop-Location }