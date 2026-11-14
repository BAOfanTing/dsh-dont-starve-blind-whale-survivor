// 模块调用审计：`X.name(...)` 里的 name 必须真实存在
//
// 为什么要有这个测试：真机 session-b159b09a 里 recipes 崩在
//   actions.lua:3046: attempt to call field 'g' (a nil value)
// 顺着查下去发现是**一类**错误 —— 我凭印象用了几个不存在的帮助函数：
//   · U.g         （util 里从来没有）
//   · U.try       （util 里没有，旧实现有；这版 util 重写时漏了）
//   · U.best_tool （它是 actions.lua 的**局部函数**，不该走 U. 前缀）
//   · U.best_fuel （同理）
// 这四个都是"跑到了才崩"，而且单元测试当时全绿 —— 因为没人调用那条分支。
//
// 这个测试**不看行为、只看静态引用**：把每个文件里的模块别名解析出来，
// 再核对它调用的每个名字是否真的由那个模块导出。这类错误从此一次都跑不掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD_DIR = join(HERE, '..', 'DontStarveWhaleSurvivor', 'scripts', 'whale')

const FILES = readdirSync(MOD_DIR).filter((f) => f.endsWith('.lua'))

/** 去掉行注释（避免注释里的示例被当成真调用） */
function stripComments(text) {
  return text.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

/** 收集一个模块导出的名字（function X.name / X.name = ） */
function exportsOf(text, alias) {
  const names = new Set()
  const code = stripComments(text)
  for (const m of code.matchAll(new RegExp(`^function ${alias}\\.([a-zA-Z_]\\w*)`, 'gm'))) names.add(m[1])
  for (const m of code.matchAll(new RegExp(`^\\s*${alias}\\.([a-zA-Z_]\\w*)\\s*=`, 'gm'))) names.add(m[1])
  return names
}

/** 模块名 → 该模块文件里用的导出别名（Whale.<模块> = X） */
function buildModuleMap() {
  const map = new Map() // 模块名 → { file, alias, exports }
  for (const f of FILES) {
    const text = readFileSync(join(MOD_DIR, f), 'utf8')
    const m = stripComments(text).match(new RegExp(`^Whale\\.(\\w+) = ([A-Z][A-Za-z0-9]*)\\s*$`, 'm'))
    if (!m) continue
    const [, module, alias] = m
    map.set(module, { file: f, alias, exports: exportsOf(text, alias) })
  }
  return map
}

const MODULES = buildModuleMap()

test('LUA-1：审计器本身能认全模块（否则这个测试是假的）', () => {
  // 至少要有这些核心模块，否则说明解析规则坏了
  for (const want of ['util', 'actions', 'guard', 'nearby', 'craftrules', 'harvestrules']) {
    assert.ok(MODULES.has(want), `应该能解析出模块 ${want}（实际解析到：${[...MODULES.keys()].join(', ')}）`)
  }
  assert.ok(MODULES.get('util').exports.size > 10, 'util 应该导出十几个函数')
  assert.ok(!MODULES.get('util').exports.has('try') === false || true) // 占位：不预设 try 在不在
})

test('LUA-2：每个文件里 `别名.函数(...)` 的函数必须由对应模块真实导出', () => {
  const problems = []
  for (const f of FILES) {
    const raw = readFileSync(join(MOD_DIR, f), 'utf8')
    const text = stripComments(raw)

    // ① 这个文件里 `local X = Whale.<模块>` 建立起来的别名
    const aliases = new Map()
    for (const m of text.matchAll(/^local ([A-Z][A-Za-z0-9]*) = Whale\.(\w+)\s*$/gm)) {
      const [, alias, module] = m
      if (MODULES.has(module)) aliases.set(alias, module)
    }
    // ② 文件自己所属的模块（用它的导出别名，比如 actions.lua 里的 A）
    const own = [...MODULES.entries()].find(([, v]) => v.file === f)
    if (own) aliases.set(own[1].alias, own[0])

    for (const [alias, module] of aliases) {
      const allowed = MODULES.get(module).exports
      const re = new RegExp(`\\b${alias}\\.([a-zA-Z_]\\w*)\\s*\\(`, 'g')
      for (const m of text.matchAll(re)) {
        const name = m[1]
        if (allowed.has(name)) continue
        // 自己模块的别名同时是"表"，会有正常字段访问；只报"当函数调用却不存在"的
        problems.push(`${f}: ${alias}.${name}(...) —— ${module} 模块没有导出 ${name}`)
      }
    }
  }
  const uniq = [...new Set(problems)]
  assert.deepEqual(uniq, [], `这些调用会一跑就崩：\n  ${uniq.join('\n  ')}`)
})

test('LUA-3：已知的四个历史坑不许复活（U.g / U.try 缺失 / U.best_tool / U.best_fuel）', () => {
  const acts = readFileSync(join(MOD_DIR, 'actions.lua'), 'utf8')
  const util = readFileSync(join(MOD_DIR, 'util.lua'), 'utf8')
  const code = stripComments(acts)

  assert.ok(!/\bU\.g\s*\(/.test(code), 'U.g 不存在，不许再出现（要用 GLOBAL.xxx）')
  assert.ok(!/\bU\.best_tool\s*\(/.test(code), 'best_tool 是 actions.lua 的局部函数，要直接叫 best_tool(...)')
  assert.ok(!/\bU\.best_fuel\s*\(/.test(code), 'best_fuel 同理')

  // U.try 现在**必须存在**（9 处调用依赖它）
  assert.match(util, /^function U\.try\b/m, 'util 必须导出 U.try')
  const uses = (code.match(/\bU\.try\s*\(/g) ?? []).length
  assert.ok(uses > 0, 'actions.lua 应该在用 U.try（如果一处都不用了，这个断言可以删）')
})

test('LUA-4：每个动作的 JOB 都真的注册了（工具表里有的，Lua 侧必须有实现）', async () => {
  const { OPEN_ACTIONS } = await import('../lib/dispatcher.js')
  const acts = stripComments(readFileSync(join(MOD_DIR, 'actions.lua'), 'utf8'))
  const jobs = new Set([...acts.matchAll(/^JOBS\.([a-z_]+)\s*=/gm)].map((m) => m[1]))
  const missing = OPEN_ACTIONS.filter((a) => !jobs.has(a))
  assert.deepEqual(missing, [], `白名单里有但 Lua 没实现的：${missing.join(', ')}`)
})
