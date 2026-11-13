// 工具表 ↔ dispatcher 白名单 ↔ 模组动作表 的一致性（M2.2.1 重写）
//
// 历史：审计（2026-11-12）发现 actions.lua 里早就写好了 JOBS.pickup，但插件从没暴露给模型，
// 于是 AI 砍完树永远捡不到木头，还没有测试会红。当时补的闸是"模组里注册的动作一个都不能漏"。
//
// M2.2.1 之后模型只暴露 dispatcher 白名单里的动作（工具表 37 → 7），所以这条闸改成盯四件事：
//   1) 工具名唯一 —— 曾经 pickup / harvest 各被重复注册过一次；
//   2) 模型可见的动作 === dispatcher 白名单（不多不少）；
//   3) 每个可见动作在模组里真的有实现；被 reflex / macros 用到的动作不能被精简带走；
//   4) 本地工具（get_state / get_guide / update_notes）走本地分支，不进 dispatcher。
//      注意：update_notes 是**写**工具（覆盖写 notes.md），只是不经过 dispatcher，不是只读。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTION_NAMES, MACRO_NAMES, TOOLS, executeTool, toolList } from '../lib/tools.js'
import { OPEN_ACTIONS } from '../lib/dispatcher.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const actionsLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions.lua'), 'utf8')
const macrosLua = readFileSync(join(MOD, 'scripts', 'whale', 'macros.lua'), 'utf8')
const reflexLua = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')

/** 模组里真正注册的动作：actions.lua 的 JOBS.xxx + macros.lua 的 A.register("xxx") */
const LUA_JOBS = new Set([
  ...[...actionsLua.matchAll(/^JOBS\.([a-z_]+)\s*=/gm)].map((m) => m[1]),
  ...[...macrosLua.matchAll(/A\.register\("([a-z_]+)"/g)].map((m) => m[1]),
])
/** 暴露给模型的全部名字（原子动作 + 宏） */
const EXPOSED = new Set([...ACTION_NAMES, ...MACRO_NAMES])
/** 不进 dispatcher 的本地工具 */
const LOCAL_NAMES = new Set(
  TOOLS.filter((t) => !ACTION_NAMES.has(t.name) && !MACRO_NAMES.has(t.name)).map((t) => t.name),
)

test('工具名唯一：不允许重复注册同名工具（曾经 pickup / harvest 各重复一次）', () => {
  const names = TOOLS.map((t) => t.name)
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  assert.deepEqual(dup, [], `这些工具被重复注册：${dup.join('、')}`)
  assert.equal(names.length, toolList().length, 'toolList 不能漏工具')
})

test('模型可见的动作 === dispatcher 白名单（不多不少）', () => {
  assert.deepEqual([...EXPOSED].sort(), [...OPEN_ACTIONS].sort(),
    '工具表暴露的动作必须和 dispatcher 放行的白名单完全一致')
  assert.deepEqual([...EXPOSED].sort(), ['harvest', 'move_to', 'pickup', 'stop'])
})

test('未开放的动作一律不在工具表里（模型看不到，也就不会去点）', () => {
  const forbidden = ['chop', 'mine', 'hammer', 'dig', 'attack', 'pick', 'eat', 'cook', 'craft',
    'build', 'make_fire', 'add_fuel', 'heal', 'equip', 'drop', 'sleep', 'say', 'wait', 'act',
    'list_actions', 'list_recipes', 'store', 'take', 'go_to', 'gather', 'chop_until',
    'cook_meal', 'night_watch']
  const leaked = forbidden.filter((n) => EXPOSED.has(n))
  assert.deepEqual(leaked, [], `这些动作还没开放，却仍然暴露给模型：${leaked.join('、')}`)
})

test('每个可见动作在模组里都真的有实现', () => {
  const missing = [...EXPOSED].filter((name) => !LUA_JOBS.has(name)).sort()
  assert.deepEqual(missing, [], `这些动作暴露给模型了、但模组里没有实现：${missing.join('、')}`)
})

test('reflex / macros 用到的模组动作不能被精简带走（它们在后台自己起动作）', () => {
  const used = new Set([
    ...[...reflexLua.matchAll(/A\.Start\("([a-z_]+)"/g)].map((m) => m[1]),
    ...[...macrosLua.matchAll(/A\.Start\("([a-z_]+)"/g)].map((m) => m[1]),
  ])
  assert.ok(used.size > 0, 'reflex/macros 应该会用 A.Start 起动作；解析不到说明脚本结构变了')
  const broken = [...used].filter((n) => !LUA_JOBS.has(n)).sort()
  assert.deepEqual(broken, [], `reflex/macros 依赖这些动作，但模组里已经没有了：${broken.join('、')}`)
  // 它们不对模型开放，所以不该出现在工具表里
  const exposedButInternal = [...used].filter((n) => EXPOSED.has(n))
  assert.ok(exposedButInternal.every((n) => OPEN_ACTIONS.includes(n)),
    `reflex/macros 内部动作不该出现在工具表里：${exposedButInternal.join('、')}`)
})

test('本地工具走本地分支：不进 dispatcher，也不需要能用的 bridge（update_notes 是写工具）', async () => {
  assert.deepEqual([...LOCAL_NAMES].sort(), ['get_guide', 'get_state', 'update_notes'])
  const boom = { call: async () => { throw new Error('本地工具不该走到 dispatcher/bridge') } }
  const guide = await executeTool('get_guide', {}, { bridge: boom, guides: {} })
  assert.equal(typeof guide, 'string')
  assert.ok(guide.length > 0, 'get_guide 应该返回内容')
})

test('未开放的动作：调用直接被拒（抛错），而且一条命令都不会发到游戏', async () => {
  const calls = []
  const ctx = {
    bridge: {
      call: async (name, args) => { calls.push({ name, args }); return { ok: true, text: '好了' } },
    },
  }
  for (const name of ['chop', 'mine', 'pick', 'attack', 'craft', 'gather', 'night_watch']) {
    await assert.rejects(
      () => executeTool(name, { count: 1 }, ctx),
      /没有这个工具/,
      `${name} 没开放，应该直接被拒`,
    )
  }
  assert.equal(calls.length, 0, '被拒的动作不该调用 bridge.call')
})

test('每个工具都有说明和参数表（模型只能靠这些猜）', () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.name, 'string', '工具要有名字')
    assert.ok(tool.name.length > 0)
    assert.equal(typeof tool.description, 'string', `${tool.name} 少了说明`)
    assert.ok(tool.description.length >= 10, `${tool.name} 的说明太短`)
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} 的 inputSchema 要是 object`)
    assert.equal(typeof tool.inputSchema?.properties, 'object', `${tool.name} 少了 properties`)
    for (const key of tool.inputSchema?.required ?? []) {
      assert.ok(tool.inputSchema.properties[key], `${tool.name} 声明了必填 ${key}，但参数表里没有`)
    }
  }
})

test('模组报出来的版本号和 modinfo.lua 一致（兜底值也不能漂）', () => {
  const modinfo = readFileSync(join(MOD, 'modinfo.lua'), 'utf8')
  const declared = modinfo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  assert.ok(declared, 'modinfo.lua 里应该有一行 version = "x.y.z"')
  const modmain = readFileSync(join(MOD, 'modmain.lua'), 'utf8')
  const fallback = modmain.match(/version\s*=\s*\(type\(version\)\s*==\s*"string"[^)]*\)\s*or\s*"([^"]+)"/)?.[1]
  assert.ok(fallback, 'modmain.lua 里应该有 version 的兜底值')
  assert.equal(fallback, declared, '模组状态里报的版本和 modinfo 对不上，排查问题时会看错版本')
})
