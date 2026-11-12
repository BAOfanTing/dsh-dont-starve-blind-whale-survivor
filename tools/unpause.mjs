// 程序化解除 DST 客户端暂停（仅用于真机测试环境准备，不用于执行游戏动作）
//
// 背景：DST 客户端打开地图/暂停菜单（或窗口失焦自动暂停）时，主机暂停会同步到
// 专用服务器，引擎不再触发任何 DoPeriodicTask → 心跳/telemetry/命令轮询全停 →
// Bridge 判超时，命令永远 QUEUED。
//
// 做法：找到 dontstarve_steam_x64 的主窗口，置前，用 SendInput 发两次 Esc
// （一次可能只是打开/关闭菜单，两次确保回到游戏）。**保持窗口在前台**，
// 因为 DST 失焦可能重新暂停。
//
// 注意：这只是环境准备，模拟按键不用于实现任何游戏动作（任务书禁止的是后者）。
// 用法：node tools/unpause.mjs [--wait 秒数]
import { execFileSync } from 'node:child_process'

const WAIT = Number(process.argv[process.argv.indexOf('--wait') + 1]) || 8

const { readFileSync } = await import('node:fs')
const { dirname, join } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '.runtime', 'token.txt'), 'utf8').trim()
const BRIDGE = 'http://127.0.0.1:18788'

/** 已经跑着就别发 Esc —— 否则会把没暂停的游戏切进暂停菜单 */
async function alreadyRunning() {
  try {
    const st = await fetch(`${BRIDGE}/api/v1/bridge/status?token=${TOKEN}`).then((r) => r.json())
    const s = await fetch(`${BRIDGE}/api/v1/state?token=${TOKEN}`).then((r) => r.json())
    return st.bridge?.connected === true && s.session?.alive === true && s.stale === false
  } catch {
    return false
  }
}

if (await alreadyRunning()) {
  console.log('游戏已在运行（connected + alive + 数据新鲜），不需要发 Esc，直接退出。')
  process.exit(0)
}

const ps = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public class Unpause {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] a, int cb);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static void Esc() {
    var a = new INPUT[2];
    a[0].type=1; a[0].ki.wVk=0x1B; a[0].ki.dwFlags=0;
    a[1].type=1; a[1].ki.wVk=0x1B; a[1].ki.dwFlags=2;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
Add-Type -TypeDefinition $code
$proc = Get-Process -Name 'dontstarve_steam_x64' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $proc) { Write-Output 'NO_WINDOW'; exit 0 }
$h = [IntPtr]$proc.MainWindowHandle
Write-Output ("WINDOW_PID=" + $proc.Id + " HANDLE=" + $h)
# 实测：窗口被最小化时 DST 会暂停，且发 Esc 无效 —— 必须先恢复
if ([Unpause]::IsIconic($h)) {
  [Unpause]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 800
  Write-Output ('RESTORED_FROM_MINIMIZED IsIconic=' + [Unpause]::IsIconic($h))
}
[Unpause]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500
Write-Output ("FOREGROUND=" + [Unpause]::GetForegroundWindow())
[Unpause]::Esc()
Start-Sleep -Milliseconds 600
[Unpause]::Esc()
Write-Output 'ESC_SENT'
`

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  process.stdout.write(out)
  if (out.includes('NO_WINDOW')) {
    console.log('  没找到 DST 客户端窗口（dontstarve_steam_x64 未运行）—— 游戏客户端没开，无法解除暂停。')
    process.exit(0)
  }
} catch (e) {
  console.error('解除暂停脚本执行失败:', String(e).slice(0, 300))
  process.exit(1)
}

// 观察 Bridge 是否恢复（用真实 token）
for (let i = 1; i <= WAIT; i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  try {
    const st = await fetch(`${BRIDGE}/api/v1/bridge/status?token=${TOKEN}`).then((r) => r.json())
    const s = await fetch(`${BRIDGE}/api/v1/state?token=${TOKEN}`).then((r) => r.json())
    const ok = st.bridge?.connected === true && s.session?.alive === true && s.stale === false
    console.log(`  t+${i * 2}s connected=${st.bridge?.connected} alive=${s.session?.alive} stale=${s.stale} 心跳距=${st.bridge?.last_heartbeat_ago_ms}ms`)
    if (ok) { console.log('  ✅ 游戏已恢复运行'); process.exit(0) }
  } catch { /* 继续等 */ }
}
console.log('  ⚠️ 等待超时，仍未恢复（可能需要手动关闭暂停菜单）')
process.exit(3)
