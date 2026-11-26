// DSH 会话预设管理：动态注册/注销带饥荒 MCP 工具的会话预设。

import { currentConfig } from './config.js'

/** 会话预设的 id。 */
export const PRESET_ID = 'dsh-dont-starve-blind-whale-survivor'
/** 预设里连游戏的 MCP 服务器名。 */
export const MCP_SERVER_NAME = 'dst'

/** 预设里连游戏的 MCP 客户端配置行（使用 @deepseek-ai/dsh-mcp-client）。 */
export function mcpClientRow(config) {
  const c = currentConfig(config)
  return {
    id: 'mcp-dst',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: MCP_SERVER_NAME,
      transport: 'streamable-http',
      url: `http://127.0.0.1:${c.port}/mcp`,
      toolCallTimeoutMs: c.actionTimeoutMinutes * 60 * 1000,
      reconnect: { maxAttempts: 100000 },
    },
  }
}

/**
 * 挑一个能用的基础预设。
 * 玩家设的 basePreset 优先；找不到就按常见 id 试一遍；再不行就拿现有的第一个。
 */
export function resolveBasePreset(presets, want) {
  const defs = presets?.definitions
  if (!defs || typeof defs.get !== 'function') return null
  const direct = defs.get(want)
  if (direct) return { id: want, definition: direct }
  for (const id of ['standard', 'default', 'minimal', 'general', 'aurabot-private']) {
    const found = defs.get(id)
    if (found) return { id, definition: found }
  }
  if (typeof defs.keys === 'function') {
    for (const id of defs.keys()) {
      const found = defs.get(id)
      if (found) return { id, definition: found }
    }
  }
  return null
}

/** 现在都有哪些预设 id（给日志用）。 */
function presetIds(presets) {
  try {
    const defs = presets?.definitions
    if (!defs) return ''
    if (typeof defs.keys === 'function') return [...defs.keys()].join(', ')
    if (typeof defs[Symbol.iterator] === 'function') return [...defs].map(([id]) => id).join(', ')
  } catch {}
  return ''
}

/**
 * 会话预设：按设置动态注册/注销。
 * 定期比对设置——在插件页里打开开关后动态生效，无需重启 DSH；基础预设未就绪时会持续等待。
 */
export function setupPreset(ctx, config, log, { everyMs = 5000 } = {}) {
  ctx.effect(() => {
    let disposed = false
    let unregister = null
    let registeredWith = ''
    let busy = false
    const warned = new Set()
    const warnOnce = (key, message) => {
      if (warned.has(key)) return
      warned.add(key)
      log('warn', message)
    }

    const tick = async () => {
      if (disposed || busy) return
      busy = true
      try {
        let presets
        try {
          presets = ctx.get?.('agentPresets')
        } catch {}
        if (!presets?.register) {
          warnOnce('noservice', '这个版本的 DSH 没有会话预设服务，没有创建饥荒预设')
          return
        }
        const c = currentConfig(config)
        if (!c.presetEnabled) {
          if (unregister) {
            const remove = unregister
            unregister = null
            registeredWith = ''
            try {
              await remove()
            } catch {}
            log('info', '已关掉饥荒会话预设')
          }
          return
        }
        if (typeof presets.definitions?.has === 'function' && presets.definitions.has(PRESET_ID) && !unregister) {
          warnOnce('exists', `已经有 id 为「${PRESET_ID}」的预设了（可能在 profile 里手写过），没有重复创建`)
          return
        }
        const resolved = resolveBasePreset(presets, c.basePreset)
        if (!resolved) {
          warnOnce('nobase', `还找不到能当底子的预设（现在有：${presetIds(presets) || '一个都没有'}），等它注册好再试`)
          return
        }
        if (resolved.id !== c.basePreset) {
          warnOnce('fallback', `没找到基础预设「${c.basePreset}」，改用「${resolved.id}」（现在有：${presetIds(presets)}）`)
        }
        const want = `${resolved.id}::${c.presetName}`
        if (unregister && registeredWith === want) return
        if (unregister) {
          const remove = unregister
          unregister = null
          registeredWith = ''
          try {
            await remove()
          } catch {}
        }
        const plugins = (resolved.definition?.config?.plugins ?? []).map((row) => ({ ...row }))
        const remove = await presets.register({
          id: PRESET_ID,
          name: c.presetName,
          description: `在「${resolved.id}」的基础上，加上玩《饥荒联机版》的工具（游戏要开着、装了大肥鱼饿不死模组）`,
          order: 50,
          plugins: [...plugins, mcpClientRow(config)],
        })
        if (disposed) {
          await remove?.()
          return
        }
        unregister = remove
        registeredWith = want
        log('info', `已创建会话预设「${c.presetName}」（基于 ${resolved.id}）：新建会话时选它就能玩饥荒`)
      } catch (error) {
        log('warn', '创建饥荒预设失败：' + (error?.message ?? error))
      } finally {
        busy = false
      }
    }

    tick()
    const timer = setInterval(tick, everyMs)
    return () => {
      disposed = true
      clearInterval(timer)
      const remove = unregister
      unregister = null
      try {
        remove?.()
      } catch {}
    }
  })
}
