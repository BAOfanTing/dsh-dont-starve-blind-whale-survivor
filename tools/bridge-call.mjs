// 给 tools/ 下的脚本共用：直接通过文件桥和游戏说话（不经过 DSH 插件）。
//
// 为什么不用 MCP：插件进程可能是旧版本（工具列表要重启 DSH 才更新），而模组侧的新动作
// 只要读档就已经在了。验证模组时的正确做法是走文件桥，把"插件转发"这一层排除掉。

import { GameBridge } from '../lib/bridge.js'

/** 造一个 call(action, args) → { ok, text, reason } */
export function makeCall({ gameDir, pollMs = 150, log = () => {} } = {}) {
  const bridge = new GameBridge({
    gameDir: gameDir ?? process.env.DST_GAME_DIR ?? "E:/SteamLibrary/steamapps/common/Don't Starve Together",
    pollMs,
    log,
  })
  return {
    bridge,
    async call(action, args = {}, { timeoutMs = 120000 } = {}) {
      const started = Date.now()
      const result = await bridge.call(action, args, { timeoutMs })
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`\n>>> ${action} ${JSON.stringify(args)}  (${seconds}s)`)
      console.log(String(result.text).split('\n').slice(0, 8).map((line) => '  ' + line).join('\n'))
      return result
    },
    /** 读游戏刚写出来的状态（带 json/text/data） */
    readState() {
      const raw = bridge.readState()
      const payload = typeof raw?.json === 'string' ? JSON.parse(raw.json) : raw?.json
      return { payload, ageMs: raw?.ageMs ?? Infinity, path: raw?.path }
    },
  }
}
