// 3C：工具 inputSchema 与 ACTION_SPECS.args 的「参数集 / 必填 / 枚举」必须逐条一致。
//
// 背景：动作的**参数约束**同时存在于两处 ——
//   1) 模型看的工具 schema：lib/actions/tool-defs.js（含给模型的参数说明文字）
//   2) 服务端校验的规格：lib/actions/specs/*.js 的 ACTION_SPECS.args
// 两处必须一致，否则会出现"模型按 schema 填、服务端按 spec 拒"的诡异现象。
//
// 为什么用「一致性闸门」而不是「从 spec 自动生成 schema」：
//   工具 schema 里有 100+ 条**只有模型能看到**的参数说明（如 move_to.x 的"目标格子 x"），
//   ACTION_SPECS.args 里没有这些说明。直接生成会把它们全删掉，等于毁掉模型唯一的操作手册。
//   所以正确做法是：保留 schema 的说明文字，用本测试死守"约束部分（参数名/必填/enum）"不许漂。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_SPECS } from '../lib/actions/specs/index.js'
import { TOOLS } from '../lib/tools.js'

const toolByName = new Map(TOOLS.map((t) => [t.name, t]))

test('TS-1：每个动作工具的 inputSchema 参数名 === ACTION_SPECS.args 的参数名', () => {
  const bad = []
  for (const [name, spec] of Object.entries(ACTION_SPECS)) {
    const tool = toolByName.get(name)
    assert.ok(tool, `动作 ${name} 没有对应的工具定义`)
    const specArgs = Object.keys(spec.args ?? {}).sort()
    const toolProps = Object.keys(tool.inputSchema?.properties ?? {}).sort()
    if (specArgs.join(',') !== toolProps.join(',')) bad.push(`${name}: spec[${specArgs.join(',')}] ≠ tool[${toolProps.join(',')}]`)
  }
  assert.deepEqual(bad, [], '动作 args 与工具 schema 参数集不一致（改一处要改两处）：\n' + bad.join('\n'))
})

test('TS-2：工具的 required === ACTION_SPECS 里 required=true 的参数', () => {
  const bad = []
  for (const [name, spec] of Object.entries(ACTION_SPECS)) {
    const tool = toolByName.get(name)
    // target_ref / snapshot_id 是"条件必填"（target_handle 与 #N 二选一），由 validateArgs 强制，
    // 不计入 schema.required 的对比。
    const COND = new Set(['target_ref', 'snapshot_id'])
    const specReq = Object.entries(spec.args ?? {})
      .filter(([k, a]) => a.required && !COND.has(k))
      .map(([k]) => k)
      .sort()
    const toolReq = (tool.inputSchema?.required ?? []).filter((k) => !COND.has(k)).slice().sort()
    if (specReq.join(',') !== toolReq.join(',')) bad.push(`${name}: spec[${specReq.join(',')}] ≠ tool[${toolReq.join(',')}]`)
  }
  assert.deepEqual(bad, [], 'required 不一致：\n' + bad.join('\n'))
})

test('TS-3：工具的 enum === ACTION_SPECS.args 里声明的 enum', () => {
  const bad = []
  for (const [name, spec] of Object.entries(ACTION_SPECS)) {
    const tool = toolByName.get(name)
    for (const [k, a] of Object.entries(spec.args ?? {})) {
      if (!a.enum) continue
      const pe = tool.inputSchema?.properties?.[k]?.enum ?? []
      if (JSON.stringify(pe) !== JSON.stringify(a.enum)) bad.push(`${name}.${k}: spec[${a.enum}] ≠ tool[${pe}]`)
    }
  }
  assert.deepEqual(bad, [], 'enum 不一致：\n' + bad.join('\n'))
})
