// 装模组：复制到 mods、写 modsettings.lua（ForceEnableMod，不是 ModManager:AddMod）、
// 修好旧版本写坏的那行、不重复加、版本一致就不动
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installMod, modStatus, MOD_NAME } from '../lib/mod-install.js'
import { tempDir } from './helpers.mjs'

const ENABLE = `ForceEnableMod("${MOD_NAME}")`
const BROKEN = `ModManager:AddMod("${MOD_NAME}")`

function fakeGame() {
  const game = tempDir('whale-game-')
  mkdirSync(join(game, 'mods'), { recursive: true })
  mkdirSync(join(game, 'bin64'), { recursive: true })
  return game
}

test('第一次装：复制整个模组目录 + 用 ForceEnableMod 打开', () => {
  const game = fakeGame()
  const result = installMod({ gameDir: game, onlyGameDir: true })
  assert.equal(result.state, 'installed')
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'modinfo.lua')))
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'scripts', 'whale', 'bridge.lua')))
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'guide', '攻略.md')))
  const settings = readFileSync(join(game, 'mods', 'modsettings.lua'), 'utf8')
  assert.ok(settings.includes(ENABLE), 'modsettings.lua 里应该有 ForceEnableMod')
  // ⚠ DST 执行 modsettings.lua 的时候还没有 ModManager，写了会让游戏启动就崩
  assert.ok(!settings.includes('ModManager'), 'modsettings.lua 里不能出现 ModManager')
})

test('第二次装：已经是最新的就不动，也不重复加', () => {
  const game = fakeGame()
  installMod({ gameDir: game, onlyGameDir: true })
  const result = installMod({ gameDir: game, onlyGameDir: true })
  assert.equal(result.state, 'current')
  const settings = readFileSync(join(game, 'mods', 'modsettings.lua'), 'utf8')
  assert.equal(settings.split(ENABLE).length - 1, 1, 'ForceEnableMod 只该有一行')
})

test('玩家自己写过 modsettings.lua 的话，只追加不覆盖', () => {
  const game = fakeGame()
  const path = join(game, 'mods', 'modsettings.lua')
  writeFileSync(path, '-- 我自己的东西\nForceEnableMod("其他模组")\n', 'utf8')
  installMod({ gameDir: game, onlyGameDir: true })
  const text = readFileSync(path, 'utf8')
  assert.match(text, /我自己的东西/)
  assert.match(text, /其他模组/)
  assert.ok(text.includes(ENABLE))
})

test('0.1.0 写坏的那行会被修掉（那行会让游戏启动就崩）', () => {
  const game = fakeGame()
  const path = join(game, 'mods', 'modsettings.lua')
  writeFileSync(path, `-- 老文件\n${BROKEN}\n`, 'utf8')
  installMod({ gameDir: game, onlyGameDir: true })
  const text = readFileSync(path, 'utf8')
  assert.ok(!text.includes('ModManager'), '写坏的 ModManager 行应该被删掉')
  assert.ok(text.includes(ENABLE), '应该换成 ForceEnableMod')
})

test('找不到游戏时说清楚怎么填', () => {
  const result = installMod({ gameDir: join(tempDir(), 'not-a-game'), onlyGameDir: true })
  assert.equal(result.state, 'notfound')
  assert.match(result.message, /游戏目录/)
})

test('modStatus 能看到装了什么版本', () => {
  const game = fakeGame()
  installMod({ gameDir: game, onlyGameDir: true })
  const status = modStatus({ gameDir: game, onlyGameDir: true })
  assert.ok(status.sourceVersion)
  assert.equal(status.games.length, 1)
  assert.equal(status.games[0].installed, true)
  assert.equal(status.games[0].installedVersion, status.sourceVersion)
})
