// 启动真实的 DSH 插件 MCP 服务（产品代码 apply()），用于 F8↔MCP 真机换手验证
// 用法：node tools/m2_0_2_start_mcp.mjs
// 保持进程存活；收到 SIGINT/SIGTERM 时 ctx.dispose() 收干净。
import { apply } from '../lib/index.js'

const cleanups = []
const ctx = {
  logger: (level, msg) => console.log(`[${level}] ${msg}`),
  effect: (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup
  },
  get: () => undefined,
  on: () => () => {},
  dispose: () => {
    while (cleanups.length) {
      const c = cleanups.pop()
      try { c() } catch {}
    }
  },
}

const config = {
  port: 18090,
  gameDir: '',
  bridgeDir: (() => { const i = process.argv.indexOf('--bridgeDir'); return i >= 0 ? process.argv[i + 1] : '' })(),
  actionTimeoutMinutes: 5,
  apiKey: '',
  baseUrl: 'https://token.sensenova.cn/v1',
  model: 'sensenova-6.8-flash',
  aiMaxTokens: 1024,
  freezeTime: false,
  idleSeconds: 8,
  extraInstructions: '',
  presetEnabled: false,
  gatewayEnabled: false,
  autoContinue: true,
  autoContinueMax: 5,
  presetName: '大肥鱼饿不死',
  basePreset: 'standard',
  autoInstallMod: false, // 游戏开着，不碰 modsettings.lua
}

apply(ctx, config)
console.log('[m2-start] apply() 已调用，等待 MCP 服务起来…')

const shutdown = () => {
  console.log('[m2-start] 收到退出信号，dispose()')
  ctx.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 每 3 秒报一次端口状态，便于外部确认
setInterval(() => {
  fetch('http://127.0.0.1:18090/status')
    .then((r) => console.log(`[m2-start] 18090 状态 HTTP ${r.status}`))
    .catch((e) => console.log(`[m2-start] 18090 还没起来: ${e.message}`))
}, 3000).unref?.()
