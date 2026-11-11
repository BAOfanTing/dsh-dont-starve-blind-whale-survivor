// 装模组：复制到 mods、写 modsettings.lua、不重复加、版本一致就不动
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installMod, modStatus, MOD_NAME } from '../lib/mod-install.js'
import { tempDir } from './helpers.mjs'

function fakeGame() {
  const game = tempDir('whale-game-')
  mkdirSync(join(game, 'mods'), { recursive: true })
  mkdirSync(join(game, 'bin64'), { recursive: true })
  return game
}

test('第一次装：复制整个模组目录 + 在 modsettings.lua 里打开', () => {
  const game = fakeGame()
  const result = installMod({ gameDir: game, onlyGameDir: true })
  assert.equal(result.state, 'installed')
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'modinfo.lua')))
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'scripts', 'whale', 'bridge.lua')))
  assert.ok(existsSync(join(game, 'mods', MOD_NAME, 'guide', '攻略.md')))
  const settings = readFileSync(join(game, 'mods', 'modsettings.lua'), 'utf8')
  assert.match(settings, /ModManager:AddMod\("DontStarveWhaleSurvivor"\)/)
})

test('第二次装：已经是最新的就不动，也不重复加 AddMod', () => {
  const game = fakeGame()
  installMod({ gameDir: game, onlyGameDir: true })
  const result = installMod({ gameDir: game, onlyGameDir: true })
  assert.equal(result.state, 'current')
  const settings = readFileSync(join(game, 'mods', 'modsettings.lua'), 'utf8')
  assert.equal(settings.match(/ModManager:AddMod/g).length, 1)
})

test('玩家自己写过 modsettings.lua 的话，只追加不覆盖', () => {
  const game = fakeGame()
  const path = join(game, 'mods', 'modsettings.lua')
  writeFileSync(path, '-- 我自己的东西\nModManager:AddMod("其他模组")\n', 'utf8')
  installMod({ gameDir: game, onlyGameDir: true })
  const text = readFileSync(path, 'utf8')
  assert.match(text, /我自己的东西/)
  assert.match(text, /其他模组/)
  assert.match(text, /DontStarveWhaleSurvivor/)
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
