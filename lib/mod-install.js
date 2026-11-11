// 把插件里带的饥荒模组装进游戏的 mods 目录，并在 modsettings.lua 里打开它
//
// 饥荒的 Lua 模组不需要编译：仓库里的 DontStarveWhaleSurvivor/ 就是成品，
// 整个文件夹复制到 <游戏>/mods/ 就行；再往 mods/modsettings.lua 里加一行 ModManager:AddMod。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGameDirs } from './bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MOD_NAME = 'DontStarveWhaleSurvivor'
export const MOD_SOURCE = join(HERE, '..', MOD_NAME)

function readVersion(modinfoPath) {
  try {
    const text = readFileSync(modinfoPath, 'utf8')
    const match = text.match(/version\s*=\s*"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function sameTree(source, target) {
  if (!existsSync(target)) return false
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, entry.name)
      const dst = join(target, rel ? join(rel, entry.name) : entry.name)
      if (entry.isDirectory()) {
        if (!existsSync(dst) || !statSync(dst).isDirectory()) return false
        if (!walk(src, rel ? join(rel, entry.name) : entry.name)) return false
      } else if (entry.isFile()) {
        if (!existsSync(dst)) return false
        const a = statSync(src)
        const b = statSync(dst)
        if (a.size !== b.size) return false
      }
    }
    return true
  }
  try {
    return walk(source, '')
  } catch {
    return false
  }
}

/** 在 modsettings.lua 里打开模组用的那一行（DST 里只有这个写法；那个阶段没有 ModManager）。 */
const ENABLE_LINE = `ForceEnableMod("${MOD_NAME}")`
/** 0.1.0 写错过的写法：DST 执行 modsettings.lua 的时候 ModManager 还不存在，会让游戏启动直接崩。 */
const BROKEN_LINE = `ModManager:AddMod("${MOD_NAME}")`

function enableInModSettings(gameDir) {
  const path = join(gameDir, 'mods', 'modsettings.lua')
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 没有就新建一个（游戏自带的那份在 mods 目录里，正常都存在）
  }
  let changed = false

  // 1) 先清掉写错的那行（升级上来的人文件里可能还留着，会崩游戏）
  if (text.includes(BROKEN_LINE)) {
    const lines = text.split(/\r?\n/)
    const kept = lines.filter((line) => !line.includes(BROKEN_LINE))
    text = kept.join('\n')
    changed = true
  }

  // 2) 保证有 ForceEnableMod
  if (!text.includes(ENABLE_LINE)) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `\n-- 大肥鱼饿不死：让 AI 来玩（想关掉就删掉下面这行，或者在游戏里的模组菜单关）\n${ENABLE_LINE}\n`
    changed = true
  }

  if (!changed) return 'already'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return text.includes(ENABLE_LINE) ? 'enabled' : 'repaired'
}

/**
 * 装/更新模组。返回 { state, message }，state ∈ installed | current | busy | error | notfound
 */
export function installMod({ gameDir = '', onlyGameDir = false } = {}) {
  if (!existsSync(MOD_SOURCE)) {
    return { state: 'error', message: `插件里找不到模组源文件：${MOD_SOURCE}` }
  }
  const sourceVersion = readVersion(join(MOD_SOURCE, 'modinfo.lua'))
  const games = findGameDirs(gameDir, { only: onlyGameDir })
  if (games.length === 0) {
    return { state: 'notfound', message: '没找到《饥荒联机版》的安装目录：请在插件设置里填「游戏目录」（里面有 bin64 和 mods 的那个文件夹）' }
  }

  const messages = []
  let state = 'current'
  for (const game of games) {
    const target = join(game, 'mods', MOD_NAME)
    const installedVersion = readVersion(join(target, 'modinfo.lua'))
    const upToDate = installedVersion === sourceVersion && sameTree(MOD_SOURCE, target)
    if (!upToDate) {
      try {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        mkdirSync(join(game, 'mods'), { recursive: true })
        cpSync(MOD_SOURCE, target, { recursive: true })
        state = 'installed'
        messages.push(`已装到 ${target}（v${sourceVersion}）`)
      } catch (error) {
        const code = error?.code ?? ''
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          state = state === 'installed' ? 'installed' : 'busy'
          messages.push(`游戏开着，${MOD_NAME} 等关掉游戏后再装`)
        } else {
          state = 'error'
          messages.push(`装到 ${target} 失败：${error?.message ?? error}`)
        }
        continue
      }
    } else {
      messages.push(`${MOD_NAME} 已经是最新的（v${sourceVersion}）`)
    }
    try {
      const settingsState = enableInModSettings(game)
      if (settingsState === 'enabled') messages.push('已在 mods/modsettings.lua 里打开它（ForceEnableMod）')
      else if (settingsState === 'repaired') messages.push('修好了 mods/modsettings.lua 里写坏的那一行')
    } catch (error) {
      messages.push(`改 modsettings.lua 失败：${error?.message ?? error}`)
    }
  }
  return { state, message: messages.join('；') }
}

/** 现在的安装情况（状态卡片用）。 */
export function modStatus({ gameDir = '', onlyGameDir = false } = {}) {
  const sourceVersion = readVersion(join(MOD_SOURCE, 'modinfo.lua'))
  const games = findGameDirs(gameDir, { only: onlyGameDir })
  return {
    sourceVersion,
    games: games.map((game) => {
      const target = join(game, 'mods', MOD_NAME)
      return {
        game,
        installed: existsSync(target),
        installedVersion: readVersion(join(target, 'modinfo.lua')),
      }
    }),
  }
}
