// 提示词 / 攻略 / 动作表的一致性闸
//
// 背景：SURVIVAL 阶段动作从 7 个一路开放到 31 个，但 RULES 里硬编码着
// "目前开放 8 个动作"、攻略里写着"只有这 7 个工具""AI 现在砍不了树"。
// 模型读到的是过时的说明书，于是不会去用已经能用的能力。
// 这组测试盯住：能力清单必须从 ACTION_SPECS 生成，不能再手写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULES, TOOLS } from '../../lib/tools.js'
import { ACTION_SPECS, OPEN_ACTIONS } from '../../lib/dispatcher.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const guide = readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'guide', '攻略.md'), 'utf8')

test('RULES 的动作数量与 ACTION_SPECS 一致（不许再写死数字）', () => {
  const n = Object.keys(ACTION_SPECS).length
  assert.match(RULES, new RegExp(`能用的动作共 ${n} 个`), `RULES 里应该写 ${n} 个`)
  assert.ok(!/目前开放 8 个动作/.test(RULES), '旧的硬编码清单必须删掉')
})

test('RULES 里点名的每个动作都真的存在，且每个动作都被提到', () => {
  const mentioned = new Set(RULES.match(/\b[a-z][a-z_]{2,}\b/g) ?? [])
  const known = new Set(TOOLS.map((t) => t.name))
  // 清单段里出现的动作名必须都在工具表里（避免写出不存在的动作）
  const capability = RULES.slice(RULES.indexOf('能用的动作共'), RULES.indexOf('工具列表里列出来的动作'))
  for (const name of capability.match(/\b[a-z][a-z_]{2,}\b/g) ?? []) {
    if (name === 'gather_area') continue
    assert.ok(known.has(name) || name.startsWith('gather'), `清单里写了不存在的动作：${name}`)
  }
  for (const name of Object.keys(ACTION_SPECS)) {
    assert.ok(mentioned.has(name), `RULES 没提到 ${name}，模型不会知道它能用`)
  }
})

test('攻略不再声称"只有 7 个工具 / 砍不了树 / 做不了工具"，也不含过时或错误描述', () => {
  assert.ok(!/只有这 7 个工具/.test(guide), '攻略里的工具数量必须更新')
  assert.ok(!/AI 现在砍不了树/.test(guide), 'chop 已经开放')
  assert.ok(!/AI 现在做不了/.test(guide), 'craft 已经开放')
  assert.ok(!/存东西（未开放）/.test(guide), 'container_* 已经开放')
  assert.ok(!/思考时暂停/.test(guide), '思考时暂停已停用，攻略不再保留')
  assert.ok(!/3\s*石头\s*\+\s*6\s*木炭/.test(guide), 'cookpot 配方是 3 cutstone，不能写 3 石头')
  assert.ok(!/twiggy_tree[^\n]*白桦/.test(guide), 'twiggy_tree 是多枝树，不是白桦')
  assert.match(guide, /chop/, '攻略要提到砍树动作')
  assert.match(guide, /container_put/, '攻略要提到存东西')
})

test('OPEN_ACTIONS 与 ACTION_SPECS 键完全一致', () => {
  assert.deepEqual(OPEN_ACTIONS.slice().sort(), Object.keys(ACTION_SPECS).sort())
})
