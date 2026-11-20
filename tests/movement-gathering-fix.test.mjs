// 验证位移到达贴身阈值与采集防打断重推修复 (Issue 1 & Issue 2)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { foodAction } from '../lib/skills/food-candidate-selector.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

test('FIX-01: movement.lua 中的 move_to 到达阈值已收紧至 <= 0.35 格（进入原生臂展）', () => {
  const content = readFileSync(join(MOD, 'scripts/whale/actions/movement.lua'), 'utf8')
  assert.match(content, /stop_dist = tonumber\(j\.args\.radius\) or tonumber\(j\.args\.stop_dist\) or 0\.35/, 'move_to 默认到达距离应为 0.35 格')
  assert.match(content, /if away <= 0\.8 then/, '障碍重试停靠阈值应收紧至 0.8 格')
  assert.match(content, /if away <= 0\.5 then/, 'go_to 停靠阈值应收紧至 0.5 格')
})

test('FIX-02: gathering.lua 中 gather_area 严格保护 loco.bufferedaction 与 doing 状态，防止动作被提前重推打断', () => {
  const content = readFileSync(join(MOD, 'scripts/whale/actions/gathering.lua'), 'utf8')
  assert.match(content, /has_ba = \(p:GetBufferedAction\(\) ~= nil\) or \(loco ~= nil and loco\.bufferedaction ~= nil\)/, '必须包含 locomotor.bufferedaction 检查')
  assert.match(content, /p\.sg:HasStateTag\("doing"\)/, '必须检查 doing 状态标签')
  assert.match(content, /if not is_acting and waited > 2\.5 then/, '重推等待窗口必须有界且在非执行中（>2.5s）才触发')
  assert.doesNotMatch(content, /if not busy\(p\) and waited > 0\.8 then/, '严禁 0.8s 提前重推打断动作')
})

test('FIX-03: foodAction 在合理距离内选择直接动作，远距离触发 move_to 走位', () => {
  const snapNear = {
    actor: { tileX: 0, tileZ: 0 },
    nearby: {
      buckets: {
        pickupables: [{ ref: '#p1', prefab: 'berries', position: { x: 1, z: 1 }, distance: 1.414 }],
        harvestables: [],
        threats: [],
      },
    },
  }
  const actNear = foodAction(snapNear)
  assert.equal(actNear.tool, 'pickup_food')

  const snapFar = {
    actor: { tileX: 0, tileZ: 0 },
    nearby: {
      buckets: {
        pickupables: [{ ref: '#p1', prefab: 'berries', position: { x: 5, z: 5 }, distance: 7.07 }],
        harvestables: [],
        threats: [],
      },
    },
  }
  const actFar = foodAction(snapFar)
  assert.equal(actFar.tool, 'move_to')
  assert.deepEqual(actFar.args, { x: 5, z: 5 })
})
