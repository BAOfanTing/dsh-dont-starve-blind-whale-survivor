// 工具表 ↔ 模组动作表的一致性
//
// 审计（2026-11-12）发现过一个真问题：actions.lua 里早就写好了 JOBS.pickup，
// 但 lib/tools.js 从来没把它暴露给模型 —— 于是 AI 砍完树永远捡不到木头，
// 而且没有任何测试会红。这个文件就是补上那道闸。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION_NAMES, TOOLS, executeTool } from '../lib/tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const actionsLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions.lua'), 'utf8')
/** actions.lua 里注册的 JOBS.xxx */
const LUA_JOBS = new Set([...actionsLua.matchAll(/^JOBS\.([a-z_]+)\s*=/gm)].map((m) => m[1]))

test('模组里注册的动作，一个都不能在插件里漏掉（漏了模型永远用不上）', () => {
  const missing = [...LUA_JOBS].filter((name) => !ACTION_NAMES.has(name)).sort()
  assert.deepEqual(missing, [], `这些动作模组里能做、但没暴露给模型：${missing.join('、')}`)
})

test('暴露给模型的动作，模组里都得真的存在（不然调用必然失败）', () => {
  const extra = [...ACTION_NAMES].filter((name) => !LUA_JOBS.has(name)).sort()
  assert.deepEqual(extra, [], `这些动作暴露给模型了、但模组里没有实现：${extra.join('、')}`)
})

test('捡东西（pickup）必须在工具表里 —— 砍树/挖矿的产出全靠它', () => {
  assert.ok(ACTION_NAMES.has('pickup'), 'pickup 没暴露：AI 砍完树拿不到木头')
})

test('采集类动作都支持「干到目标消失」和上限，且说明里讲清掉落物要 pickup', () => {
  for (const name of ['chop', 'mine', 'hammer', 'dig']) {
    const tool = TOOLS.find((t) => t.name === name)
    assert.ok(tool, `少了 ${name}`)
    const props = tool.inputSchema?.properties ?? {}
    assert.ok(props.until_gone, `${name} 没暴露 until_gone：count 到底指"几下"还是"几个"说不清`)
    assert.ok(props.max_hits, `${name} 没暴露 max_hits：卡住时没法兜底`)
    assert.match(tool.description, /pickup/, `${name} 的说明要提醒模型去捡掉落物`)
  }
})

test('每个工具都有说明和参数表（模型只能靠这些猜）', () => {  for (const tool of TOOLS) {
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

test('干活类动作默认带上 until_gone=true（不然砍一下就走，木头拿不到）', async () => {
  const calls = []
  const ctx = {
    bridge: {
      call: async (name, args) => {
        calls.push({ name, args })
        return { ok: true, text: '好了' }
      },
    },
  }
  await executeTool('chop', { count: 1 }, ctx)
  await executeTool('mine', {}, ctx)
  await executeTool('chop', { count: 1, until_gone: false }, ctx)
  await executeTool('pick', { count: 1 }, ctx)

  assert.deepEqual(calls[0].args, { count: 1, until_gone: true }, 'chop 应该自动补上 until_gone')
  assert.deepEqual(calls[1].args, { until_gone: true }, 'mine 也一样')
  assert.equal(calls[2].args.until_gone, false, '模型显式给 false 时要尊重')
  assert.equal(calls[3].args.until_gone, undefined, 'pick 不该被塞 until_gone')
})
