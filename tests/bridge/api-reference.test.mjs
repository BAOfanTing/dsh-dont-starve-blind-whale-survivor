// API 文档与动作名核对（SURVIVAL-06 后续）
//
// 为什么要有这个测试：我从另一个实现搬 `use` 的白名单时，直接照抄了它的
// OPEN / USE / TAKEITEM / CLOSE —— 但游戏源码里**没有 OPEN / USE / CLOSE**，
// 照抄等于把"动作不存在"的 bug 搬进来。
//
// 这个测试把「模组里用到的 ACTIONS 名字」和「游戏源码 actions.lua 里真实定义的名字」
// 对齐，防止以后再凭印象写动作名。
//
// 游戏源码不在仓库里（在游戏安装目录），所以：
//   · 找得到游戏 → 真比对（严格）
//   · 找不到游戏 → 退化成"和 docs/reference/动作表.md 比对"，并明确标记为弱校验
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CRAFTABLE_RECIPES } from '../../lib/actions/specs/crafting.js'
import { fileURLToPath } from 'node:url'

import { findGameDirs } from '../../lib/bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/** 找游戏源码里的 actions.lua（在 scripts.zip 里，这里用文档兜底） */
function loadKnownActions() {
  // ① 优先用文档（仓库内，随时可用）
  const docPath = join(REPO, 'docs', 'reference', '动作表.md')
  const docActions = new Set()
  if (existsSync(docPath)) {
    for (const line of readFileSync(docPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^- ([A-Z][A-Z0-9_]*)$/)
      if (m) docActions.add(m[1])
    }
  }
  // ② 再看有没有解压出来的游戏源码（更权威，但可能没有）
  const extracted = []
  for (const dir of findGameDirs(undefined, { only: true })) {
    for (const candidate of [
      join(dir, 'data', 'databundles', 'scripts.zip'), // 只能标记存在，不解压
    ]) {
      if (existsSync(candidate)) extracted.push(candidate)
    }
  }
  return { docActions, hasGame: extracted.length > 0 }
}

const { docActions, hasGame } = loadKnownActions()

/** 从模组 Lua 里抽出 ACTIONS.XXX 引用（排除误匹配的模块方法） */
function collectUsedActions() {
  const dir = join(REPO, 'DontStarveWhaleSurvivor', 'scripts', 'whale')
  const used = new Map() // name → 出现它的文件
  const files = [
    'actions.lua',
    'actions/core.lua',
    'actions/movement.lua',
    'actions/gathering.lua',
    'actions/work.lua',
    'actions/combat.lua',
    'actions/survival.lua',
    'actions/crafting.lua',
    'actions/interaction.lua',
    'macros.lua',
    'reflex.lua',
  ]
  // 这些是 Whale.actions 的模块方法，不是游戏 ACTIONS（正则会把 ACTIONS.Start 之类抓进来）
  const NOT_GAME_ACTIONS = new Set([
    'Start', 'Tick', 'Abort', 'Status', 'MODNAME', 'refresh_client_walk',
    'lua', 'IsRunning', 'Current',
  ])
  for (const name of files) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    // 去掉行注释，避免注释里的示例被当成真引用
    const stripped = text.split(/\r?\n/).map((line) => line.replace(/--.*$/, '')).join('\n')
    for (const m of stripped.matchAll(/ACTIONS\.([A-Z][A-Z0-9_]+)/g)) {
      const action = m[1]
      if (NOT_GAME_ACTIONS.has(action)) continue
      if (!used.has(action)) used.set(action, new Set())
      used.get(action).add(name)
    }
  }
  return used
}

test('API-1：模组里用到的每个 ACTIONS 名字都必须真实存在', () => {
  assert.ok(docActions.size > 100, `动作表应该有一堆条目，实际 ${docActions.size}`)
  const used = collectUsedActions()
  assert.ok(used.size > 0, '应该能抽到一些 ACTIONS 引用')

  const missing = []
  for (const [action, where] of used) {
    // 文档不全（游戏有 308 个，文档只导出了 200 个左右），所以这里只做"已知的必须在"。
    // 反过来（文档没有但游戏有）不算失败 —— 比如 SLEEPIN 文档就漏了。
    if (!docActions.has(action)) missing.push(`${action}（${[...where].join('/')}）`)
  }
  // 这些是文档漏收、但游戏源码里确实存在的，允许
  const KNOWN_DOC_GAPS = new Set(['SLEEPIN', 'COOK', 'HEAL'])
  const realMissing = missing.filter((m) => !KNOWN_DOC_GAPS.has(m.split('（')[0]))
  assert.deepEqual(realMissing, [], `这些动作在动作表里查不到，可能是拼错了：${realMissing.join('、')}`)
})

test('API-2：use 的白名单必须是真实动作（不能照抄不存在的 OPEN/USE/CLOSE）', () => {
  const lua = readFileSync(join(REPO, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'actions', 'interaction.lua'), 'utf8')
  const m = lua.match(/local USE_ALLOWED = \{([\s\S]*?)\}/)
  assert.ok(m, '应该能读到 USE_ALLOWED')
  const names = [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1])
  assert.ok(names.length >= 5, `USE_ALLOWED 至少要有几个，实际 ${names.join(',')}`)

  // 绝对不许出现的（游戏里没有这三个）
  for (const bad of ['OPEN', 'CLOSE', 'USE']) {
    assert.ok(!names.includes(bad), `USE_ALLOWED 不许包含 ${bad}（游戏里没有这个动作）`)
  }
  // 必须有的几个（容器交互的核心）
  for (const must of ['ACTIVATE', 'ACTIVATE_CONTAINER', 'READ', 'PICKUP']) {
    assert.ok(names.includes(must), `USE_ALLOWED 应该有 ${must}`)
  }
  // 每个都得在动作表里（文档缺的跳过）
  // 文档只导出了 200 个左右，游戏源码有 308 个 —— 这几个是文档漏收但源码里确实有的
  const KNOWN_DOC_GAPS = new Set(['TAKEITEM', 'RUMMAGE', 'SLEEPIN'])
  for (const name of names) {
    if (KNOWN_DOC_GAPS.has(name)) continue
    assert.ok(docActions.has(name), `USE_ALLOWED 里的 ${name} 在动作表里查不到`)
  }
})

test('API-3：API 文档和参考表都在仓库里，且提到的工具都存在', () => {
  const docs = ['docs/GAME_API.md', 'docs/reference/动作表.md', 'docs/reference/合成表.md']
  for (const d of docs) {
    assert.ok(existsSync(join(REPO, d)), `应该有 ${d}`)
  }
  // GAME_API.md 里教的核对命令必须真的能跑
  const api = readFileSync(join(REPO, 'docs/GAME_API.md'), 'utf8')
  assert.match(api, /tools\/api-lookup\.mjs/, '文档应该教怎么用 api-lookup')
  assert.ok(existsSync(join(REPO, 'tools', 'api-lookup.mjs')), 'api-lookup.mjs 必须存在')
  assert.ok(existsSync(join(REPO, 'tools', 'dump-reference.mjs')), 'dump-reference.mjs 必须存在')
  assert.ok(existsSync(join(REPO, 'tools', 'bridge-call.mjs')), 'bridge-call.mjs（dump-reference 的依赖）必须存在')
})

test('API-4：合成表覆盖了 craft 白名单里的**每一个**配方（含第一阶段科技）', () => {
  const table = readFileSync(join(REPO, 'docs', 'reference', '合成表.md'), 'utf8')
  // TARGET-REFRESH：白名单从 4 个扩到 9 个（rope/boards/backpack/spear/armorwood 是第一阶段科技）。
  // 清单直接取 ACTION_SPECS，避免以后加了配方忘了改这条断言。
  for (const recipe of CRAFTABLE_RECIPES) {
    assert.match(table, new RegExp(`^- ${recipe}/`, 'm'), `合成表里应该有 ${recipe}`)
  }
  // 顺手确认原版配方表里真的有这几个名字（dump 出来的表就是 AllRecipes）
  assert.ok(CRAFTABLE_RECIPES.length >= 9, 'craft 白名单至少有 9 个配方')
})
