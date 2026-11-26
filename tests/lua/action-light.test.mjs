// 点火烧树（ACTIONS.LIGHT）：Node 规格/工具定义/技能规划 + Fengari 真 Lua 沙箱集成测试
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, validateArgs } from '../../lib/dispatcher.js'
import { TOOLS } from '../../lib/tools.js'
import { actionForMissing } from '../../lib/skills/skill-utils.js'
import { nearbyLines } from '../../lib/state/snapshot.js'
import { loadTargets, testAuthority, RUNTIME } from '../helpers/target-harness.mjs'
import { command } from '../helpers/helpers.mjs'

// ─────────────────────────── Node 侧（UNIT）───────────────────────────

test('LIGHT-1：use 工具与规格允许并描述了 LIGHT 动作', () => {
  const spec = ACTION_SPECS.use
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n1', action: 'LIGHT' }).ok, true)
  assert.equal(validateArgs(spec, { target_handle: 'h1a', action: 'LIGHT' }).ok, true)

  const useTool = TOOLS.find((t) => t.name === 'use')
  assert.ok(useTool, '工具表必须有 use')
  assert.match(useTool.description, /LIGHT/)
  assert.match(useTool.inputSchema.properties.action.description, /LIGHT/)
})

test('LIGHT-2：use.verify 针对 LIGHT 按燃烧/烧焦/消失核对，不能靠 interaction_sent 蒙混过关', () => {
  const spec = ACTION_SPECS.use
  const tree = { ref: '#2', handle: 'h2a', prefab: 'evergreen', position: { x: 10, z: -5 } }
  const before = {
    player: { inventory: { items: [] } },
    nearby: { buckets: { resources: [tree] } },
  }

  // 还没点着（没着火、没烧焦、目标还在）→ 必须判 unverified (target_not_ignited)
  const vSame = spec.verify(before, before, { target_handle: 'h2a', action: 'LIGHT' })
  assert.equal(vSame.ok, false)
  assert.equal(vSame.reason, 'target_not_ignited')

  // 点着了（is_burning=true）→ 成功
  const afterBurning = {
    player: { inventory: { items: [] } },
    nearby: { buckets: { resources: [{ ...tree, is_burning: true }] } },
  }
  const vBurn = spec.verify(before, afterBurning, { target_handle: 'h2a', action: 'LIGHT' })
  assert.equal(vBurn.ok, true)
  assert.equal(vBurn.how, 'ignited')

  // 烧焦了（is_burnt=true）→ 成功
  const afterBurnt = {
    player: { inventory: { items: [] } },
    nearby: { buckets: { resources: [{ ...tree, is_burnt: true }] } },
  }
  const vBurnt = spec.verify(before, afterBurnt, { target_handle: 'h2a', action: 'LIGHT' })
  assert.equal(vBurnt.ok, true)
  assert.equal(vBurnt.how, 'burnt')

  // 目标消失（比如草丛烧成了灰）→ 成功
  const afterGone = {
    player: { inventory: { items: [] } },
    nearby: { buckets: { resources: [] } },
  }
  const vGone = spec.verify(before, afterGone, { target_handle: 'h2a', action: 'LIGHT' })
  assert.equal(vGone.ok, true)
  assert.equal(vGone.how, 'target_gone')
})

test('LIGHT-3：nearbyLines 文本正确渲染 着火中 / 已烧焦', () => {
  const lines = nearbyLines({
    status: 'ok',
    radius: 16,
    snapshot_id: 'r1-n1',
    buckets: {
      resources: [
        { ref: '#1', label: '常青树', position: { x: 1, z: 2 }, distance: 1.5, work_action: 'CHOP', is_burning: true },
        { ref: '#2', label: '常青树', position: { x: 3, z: 4 }, distance: 2.0, work_action: 'CHOP', is_burnt: true },
      ],
    },
  }).join('\n')
  assert.match(lines, /#1 常青树.*可CHOP 着火中/)
  assert.match(lines, /#2 常青树.*可CHOP 已烧焦/)
})

test('LIGHT-4：skill-utils 对 charcoal 的完整决策链（捡炭→等烧完→不砍焦树→点火烧树→先做火把）', () => {
  const base = {
    actor: { tileX: 0, tileZ: 0 },
    player: { inventory: { items: [] }, equipment: { slots: {} } },
    nearby: { snapshot_id: 'r1-n1', buckets: { pickupables: [], resources: [] } },
  }

  // 1) 地上有现成木炭 → 直接去捡
  const withGround = {
    ...base,
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: {
        pickupables: [{ ref: '#1', prefab: 'charcoal', position: { x: 1, z: 0 }, distance: 1.0 }],
        resources: [],
      },
    },
  }
  assert.deepEqual(actionForMissing(withGround, 'charcoal'), {
    tool: 'pickup_nearest',
    args: { target_kind: 'charcoal' },
  })

  // 2) 有树正在烧 → 原地等，**不要**跑去点新树（火会自己蔓延）
  //    ★ 真机教训：每棵都去点新的，等于把"等 45 秒"重复 6 次，白烧 5 分钟和周围的浆果丛。
  const withBurning = {
    ...base,
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: {
        pickupables: [],
        resources: [{ ref: '#1', handle: 'hb2', prefab: 'evergreen', position: { x: 1, z: 0 }, distance: 1.0, work_action: 'CHOP', is_burning: true }],
      },
    },
  }
  const burningAct = actionForMissing(withBurning, 'charcoal')
  assert.equal(burningAct.tool, 'wait', '有树在烧时必须等，不能去点下一棵')
  assert.ok(burningAct.args.seconds >= 15,
    `等待时间要够树烧完（≈45 秒），实际 ${burningAct.args.seconds} 秒 —— 5 秒会空转十几轮`)

  // 3) 已烧焦的树 → **绝不 chop**（workable 已被移除，会报 target_not_workable），
  //    木炭是烧完自动掉地上的；这里应该是"走过去/等掉落"。
  const withBurnt = {
    ...base,
    player: { inventory: { items: [{ prefab: 'axe', count: 1 }] }, equipment: { slots: {} } },
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: {
        pickupables: [],
        resources: [{ ref: '#1', handle: 'hb1', prefab: 'evergreen', position: { x: 1, z: 0 }, distance: 1.0, work_action: 'CHOP', is_burnt: true }],
      },
    },
  }
  const burntAct = actionForMissing(withBurnt, 'charcoal')
  assert.notEqual(burntAct.tool, 'chop', '已烧焦的树不能 chop（会 target_not_workable）')
  assert.ok(['wait', 'move_to'].includes(burntAct.tool),
    `焦树只该走过去或等掉落，实际 ${burntAct.tool}`)

  // 4) 有普通树 + 有火把 → use action=LIGHT 点燃树
  const withTreeAndTorch = {
    ...base,
    player: { inventory: { items: [{ prefab: 'torch', count: 1 }] }, equipment: { slots: {} } },
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: {
        pickupables: [],
        resources: [{ ref: '#1', handle: 'ht1', prefab: 'evergreen', position: { x: 2, z: 0 }, distance: 2.0, work_action: 'CHOP' }],
      },
    },
  }
  assert.deepEqual(actionForMissing(withTreeAndTorch, 'charcoal'), {
    tool: 'use',
    args: { target_handle: 'ht1', action: 'LIGHT' },
  })

  // 5) 有普通树但没有火把，背包有草和树枝 → 先 craft torch
  const withTreeNoTorch = {
    ...base,
    player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 2 }] }, equipment: { slots: {} } },
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: {
        pickupables: [],
        resources: [{ ref: '#1', handle: 'ht1', prefab: 'evergreen', position: { x: 2, z: 0 }, distance: 2.0, work_action: 'CHOP' }],
      },
    },
  }
  assert.deepEqual(actionForMissing(withTreeNoTorch, 'charcoal'), {
    tool: 'craft',
    args: { recipe: 'torch' },
  })
})

test('LIGHT-9：use 的超时预算必须够「点火 + 撤离」，不能被压到 3 秒', async () => {
  // ★ 真机事故（2026-11-26）：use 的 cap 原来是 15000ms，
  //   budget_s = 15000/1000 - 15 = 0 → Math.max(3, 0) = 3 秒，
  //   于是 `use action=LIGHT` 直接报 "这一步用了 3 秒还没完（上限 3 秒）"，
  //   撤离阶段根本没机会跑，点火等于白点（人还站在火边）。
  const { createDispatcher } = await import('../../lib/dispatcher.js')
  let seenTimeout = null
  const bridge = {
    call: async (_t, _a, opts) => {
      seenTimeout = opts?.timeoutMs ?? null
      return { ok: true, text: '点燃了 常青树，并撤到 6 格外' }
    },
  }
  const lease = { generation: 1, authority_epoch: 'e1', lease_id: 'l1', owner_type: 'mcp_client', owner_instance_id: 'inst-1' }
  const control = {
    acquire: () => ({ ok: true, lease }),
    release: () => {},
    readAuthority: () => ({ ...lease, status: 'active' }),
    validate: () => ({ ok: true, lease }),
    verifyAuthority: () => ({ ok: true }),
  }
  const snap = {
    stale: false,
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0, actorId: 'player:KU_t' },
    player: { inventory: { items: [] }, equipment: { slots: {} }, health: { current: 100, max: 150 }, hunger: { current: 100, max: 150 } },
    world: { day: 1, phase: 'day' },
    identity: { sessionId: 's', shardId: '1', worldKey: 'w' },
    nearby: {
      snapshot_id: 'r1-n1',
      buckets: { resources: [{ ref: '#1', handle: 'h1a', prefab: 'evergreen', position: { x: 2, z: 0 }, is_burning: true }] },
    },
  }
  const dispatcher = createDispatcher({ bridge, control, readSnapshot: () => snap, log: () => {} })
  const out = await dispatcher.dispatch({
    tool: 'use',
    args: { target_handle: 'h1a', action: 'LIGHT' },
    owner: 'mcp_client',
    ownerInstanceId: 'inst-1',
  })
  assert.ok(out, 'dispatch 应该有结果')
  assert.ok(Number.isFinite(seenTimeout), 'bridge.call 应该收到 timeoutMs')
  assert.ok(seenTimeout >= 20000,
    `use 的超时必须够撤离（≥20s），实际 ${seenTimeout}ms —— 被压到 3 秒就会 budget_exceeded`)
})

// ─────────────────────────── Lua 沙箱集成（INTEGRATION）───────────────────────────

const LIGHT_PRELOAD = `
function mktree(opts)
    opts = opts or {}
    local e = mkent({ prefab = opts.prefab or "evergreen", guid = opts.guid or 101,
                      x = opts.x or 4, z = opts.z or 0, work = "CHOP", workleft = opts.workleft or 10,
                      tags = opts.tags or { canlight = true } })
    local burning = opts.burning == true
    e.components.burnable = {
        canlight = opts.canlight ~= false,
        IsBurning = function() return burning end,
        SetBurning = function(v)
            burning = v
            e.tags.fire = v
            e.tags.canlight = not v
        end,
    }
    if burning then e.tags.fire = true end
    return e
end

function mktouch(opts)
    opts = opts or {}
    local t = {
        prefab = opts.prefab or "torch",
        components = {
            lighter = {},
            equippable = {},
            fueled = {
                IsEmpty = function() return opts.empty == true end,
                GetPercent = function() return opts.percent or 0.8 end,
            },
            stackable = { StackSize = function() return 1 end },
        },
    }
    t.IsValid = function() return true end
    t.IsInLimbo = function() return false end
    t.HasTag = function() return false end
    return t
end
`

/** 让撤离阶段能真的"走路"：GoToPoint 纯记录，别再回调 PushAction（否则递归栈溢出） */
const WALK_STUB = `
    EQUIPPED_HAND = nil
    PLAYER.components.inventory.Equip = function(self, item) EQUIPPED_HAND = item end
    PLAYER.components.inventory.GetEquippedItem = function(self, slot)
        if slot == "hands" then return EQUIPPED_HAND end
        return nil
    end
    PLAYER.components.locomotor = {
        Stop = function() end,
        Clear = function() end,
        PushAction = function(self, ba) PUSHED[#PUSHED + 1] = ba end,
        GoToPoint = function() end,
        WantsToMoveForward = function() return false end,
        WantsToRun = function() return false end,
    }
    GLOBAL.GetClientModRPC = function() return 0 end
    GLOBAL.SendModRPCToClient = function() end
`

test('LIGHT-5（INTEGRATION）：guard + interaction 用火把点燃常青树，正确装备火把并带 invobject 下发 ACTIONS.LIGHT', async () => {
  // ★ fengari 的 C 栈很浅：在同一个 Lua state 里连续做多次「深层 pcall 嵌套」的 guard.validate
  //   会累积耗尽 C 栈，第二次起就抛 `stack overflow`（纯沙箱限制，真机 Lua 5.1 没有这个问题）。
  //   所以这里每个场景各用一个独立 state，而不是在一个 state 里连着跑。
  const luaBurnt = await loadTargets({
    preload: LIGHT_PRELOAD + WALK_STUB,
    entities: [
      `mktree({ guid = 101, x = 4, z = 0 })`,
      `mktree({ guid = 102, x = 8, z = 0, tags = { burnt = true }, canlight = false })`,
    ],
    items: [`mktouch({ prefab = "torch", percent = 0.75 })`],
  })

  luaBurnt.run(`
    SNAP = Whale.nearby.Observe(PLAYER, { tile_x = 0, tile_z = 0 }, 1000, { radius = 16, identity = { session_id = "sess-T", shard_id = "1" } })
    SID = SNAP.snapshot_id
    BURNT_REF = nil
    for _, item in ipairs(SNAP.buckets.resources) do
        if item.is_burnt then BURNT_REF = item.ref end
    end
  `)
  const sidBurnt = luaBurnt.get('SID')
  const burntRef = luaBurnt.get('BURNT_REF')
  assert.ok(burntRef, '应该找到已烧焦树')

  // 1) 已烧焦的树在 guard 阶段就被拒绝 (already_burnt)
  const burntCmd = command(testAuthority(), {
    command_id: 'cmd-burnt-1',
    action: 'use',
    args: { target_ref: burntRef, snapshot_id: sidBurnt, action: 'LIGHT' },
    snapshot_id: sidBurnt,
    target_ref: burntRef,
  })
  luaBurnt.run(`OK_BURNT, WHY_BURNT = Whale.guard.validate(Whale.json.decode(${JSON.stringify(JSON.stringify(burntCmd))}))`)
  assert.equal(luaBurnt.get('WHY_BURNT'), 'already_burnt')

  // 2) 换一个干净的 state：普通树通过 guard 并执行 JOBS.use(action=LIGHT)
  const lua = await loadTargets({
    preload: LIGHT_PRELOAD + WALK_STUB,
    entities: [
      `mktree({ guid = 101, x = 4, z = 0 })`,
      `mktree({ guid = 102, x = 8, z = 0, tags = { burnt = true }, canlight = false })`,
    ],
    items: [`mktouch({ prefab = "torch", percent = 0.75 })`],
  })
  lua.run(`
    SNAP = Whale.nearby.Observe(PLAYER, { tile_x = 0, tile_z = 0 }, 1000, { radius = 16, identity = { session_id = "sess-T", shard_id = "1" } })
    SID = SNAP.snapshot_id
    TREE_REF = nil
    for _, item in ipairs(SNAP.buckets.resources) do
        if not item.is_burnt then TREE_REF = item.ref end
    end
  `)
  const sid = lua.get('SID')
  const treeRef = lua.get('TREE_REF')
  assert.ok(treeRef, '应该找到普通树')

  const okCmd = command(testAuthority(), {
    command_id: 'cmd-light-1',
    action: 'use',
    args: { target_ref: treeRef, snapshot_id: sid, action: 'LIGHT' },
    snapshot_id: sid,
    target_ref: treeRef,
  })
  lua.run(`
    OK_USE, WHY_USE, DETAIL = Whale.guard.validate(Whale.json.decode(${JSON.stringify(JSON.stringify(okCmd))}))
    assert(OK_USE, "guard should accept LIGHT: " .. tostring(WHY_USE))
    local started, err = Whale.actions.Start("use", { target_ref = ${JSON.stringify(treeRef)}, snapshot_id = ${JSON.stringify(sid)}, action = "LIGHT" }, "cmd-light-1", {
        target = DETAIL.target,
        use_action = "LIGHT",
    })
    assert(started, "Start should succeed: " .. tostring(err))
    Whale.actions.Tick()
    PUSH_COUNT = #PUSHED
    PUSH_ACT = PUSHED[1] and PUSHED[1].action and PUSHED[1].action.id or ""
    PUSH_INV = PUSHED[1] and PUSHED[1].invobject and PUSHED[1].invobject.prefab or ""
    EQUIP_PREFAB = EQUIPPED_HAND and EQUIPPED_HAND.prefab or ""
    JOB_STILL_RUNNING = (Whale.job ~= nil) and "yes" or "no"
    -- 模拟树真的点着了
    WORLD[1].components.burnable.SetBurning(true)
    Whale.actions.Tick()
    -- 真机事故 2026-11-26：点着之后必须进入"撤离"阶段，而不是立刻收工站火边
    JOB_AFTER_IGNITE = (Whale.job ~= nil) and "yes" or "no"
    JOB_STEP_AFTER_IGNITE = (Whale.job ~= nil and Whale.job.step) or ""
    FLEE_TX = Whale.job ~= nil and Whale.job.data and Whale.job.data.flee_tx or nil
    FLEE_TZ = Whale.job ~= nil and Whale.job.data and Whale.job.data.flee_tz or nil
  `)
  // ★ 单独一次 run 去渲染文本：和上面的 Tick 放在同一个 chunk 里会触发 fengari 栈溢出
  //   （长 chunk + 深层 pcall 嵌套），拆开执行结果完全一样。
  //   注意用 Observe（只采样）+ Render，而不是 Build：Build 内部又套一层 pcall，沙箱 C 栈扛不住。
  lua.run(`
    DATA2 = Whale.observe.BuildData(PLAYER, { seq = 2, now = 1005 })
    TEXT2 = Whale.observe.Render(DATA2)
  `)

  assert.equal(lua.get('PUSH_COUNT'), '1')
  assert.equal(lua.get('PUSH_ACT'), 'LIGHT')
  assert.equal(lua.get('PUSH_INV'), 'torch')
  assert.equal(lua.get('EQUIP_PREFAB'), 'torch')
  assert.equal(lua.get('JOB_STILL_RUNNING'), 'yes')
  // 点着后仍然在跑（撤离中），不会原地站着收工
  assert.equal(lua.get('JOB_AFTER_IGNITE'), 'yes', '点着后必须先撤离，不能立刻结束')
  assert.equal(lua.get('JOB_STEP_AFTER_IGNITE'), 'fleeing', '点着后应进入 fleeing 阶段')
  assert.ok(lua.get('FLEE_TX'), '必须规划出撤离点坐标')
  assert.ok(lua.get('FLEE_TZ'))
  assert.match(lua.get('TEXT2'), /着火中/)
  assert.match(lua.get('TEXT2'), /已烧焦/)
})

test('LIGHT-6（INTEGRATION）：没有火把等点火物品时，guard 拒绝并给出 no_lighter 提示', async () => {
  const lua = await loadTargets({
    preload: LIGHT_PRELOAD + WALK_STUB,
    entities: [`mktree({ guid = 201, x = 4, z = 0 })`],
    items: [], // 背包空空
  })

  lua.run(`
    SNAP = Whale.nearby.Observe(PLAYER, { tile_x = 0, tile_z = 0 }, 1000, { radius = 16, identity = { session_id = "sess-T", shard_id = "1" } })
    SID = SNAP.snapshot_id
    TREE_REF = SNAP.buckets.resources[1].ref
  `)
  const sid = lua.get('SID')
  const treeRef = lua.get('TREE_REF')

  const cmd = command(testAuthority(), {
    command_id: 'cmd-nolighter-1',
    action: 'use',
    args: { target_ref: treeRef, snapshot_id: sid, action: 'LIGHT' },
    snapshot_id: sid,
    target_ref: treeRef,
  })
  lua.run(`OK, WHY = Whale.guard.validate(Whale.json.decode(${JSON.stringify(JSON.stringify(cmd))}))`)
  assert.equal(lua.get('WHY'), 'no_lighter')
})

// ★ 真机事故（2026-11-26）：点完火站在原地不动，火顺着周围草/浆果丛烧过来，
//   温蒂从 30 血被烧到 0 —— 直接烧死变灵魂。撤离必须是"点火"的一部分，不能靠模型记得。
test('LIGHT-7（INTEGRATION）：flee_point_from 在火点正后方挑出可站立的撤离点', async () => {
  const lua = await loadTargets({
    preload: LIGHT_PRELOAD + WALK_STUB,
    entities: [`mktree({ guid = 301, x = 8, z = 0 })`],
    items: [],
  })

  lua.run(`
    -- 玩家在 (0,0)，树在 (8,0) 世界单位 → 正后方就是 -x 方向
    FLEE_X, FLEE_Z = Whale.actions.flee_point_from(PLAYER, WORLD[1], 6)
    FLEE_TILES = Whale.actions.LIGHT_FLEE_TILES
  `)

  assert.equal(lua.get('FLEE_TILES'), '6', '撤离距离应为 6 格')
  const fx = Number(lua.get('FLEE_X'))
  const fz = Number(lua.get('FLEE_Z'))
  assert.ok(Number.isFinite(fx) && Number.isFinite(fz), '应该算出一个撤离格子')
  // 世界单位 -24 → 格子 -6（tile_of 用 floor）
  assert.ok(fx <= -4, `撤离点应该背对火源（x 明显为负），实际 x=${fx}`)
})

test('LIGHT-8（INTEGRATION）：点燃后 job 进入 fleeing 并调用走位，而不是原地结束', async () => {
  const lua = await loadTargets({
    preload: LIGHT_PRELOAD + `
      WALKED = 0
      EQUIPPED_HAND = nil
      PLAYER.components.inventory.Equip = function(self, item) EQUIPPED_HAND = item end
      PLAYER.components.inventory.GetEquippedItem = function(self, slot)
          if slot == "hands" then return EQUIPPED_HAND end
          return nil
      end
      PLAYER.components.locomotor = {
          Stop = function() end,
          Clear = function() end,
          PushAction = function(self, ba) PUSHED[#PUSHED + 1] = ba end,
          GoToPoint = function(self, pt) WALKED = WALKED + 1 end,
          WantsToMoveForward = function() return false end,
          WantsToRun = function() return false end,
      }
      GLOBAL.GetClientModRPC = function() return 0 end
      GLOBAL.SendModRPCToClient = function() end
    `,
    entities: [`mktree({ guid = 401, x = 4, z = 0 })`],
    items: [`mktouch({ prefab = "torch", percent = 0.9 })`],
  })

  lua.run(`
    SNAP = Whale.nearby.Observe(PLAYER, { tile_x = 0, tile_z = 0 }, 1000, { radius = 16, identity = { session_id = "sess-T", shard_id = "1" } })
    SID = SNAP.snapshot_id
    REF = SNAP.buckets.resources[1].ref
    local cmd = {
        protocol_version = 1, command_id = "cmd-flee-2", action = "use",
        args = { target_ref = REF, snapshot_id = SID, action = "LIGHT" },
        requested_by = "f8_agent", owner_type = "f8_agent", owner_instance_id = "instance-A",
        authority_epoch = "epoch-A", lease_id = "lease-A", lease_generation = 12,
        lease_expires_at = 1794500060000, runtime_id = "${RUNTIME}",
        session_id = "sess-T", shard_id = "1", actor_id = "player:KU_t",
        created_at = 1794500000000, expires_at = 1794500008000,
        snapshot_id = SID, target_ref = REF,
    }
    local ok, why, detail = Whale.guard.validate(cmd)
    assert(ok, "guard 应放行 LIGHT：" .. tostring(why))
    assert(Whale.actions.Start("use", cmd.args, "cmd-flee-2", { target = detail.target, use_action = "LIGHT" }))
    Whale.actions.Tick()
    -- 点火动作已下发；把它当作"已经点着"
    WORLD[1].components.burnable.SetBurning(true)
    WALKED_BEFORE = WALKED
    Whale.actions.Tick()
    STEP = Whale.job and Whale.job.step or "none"
    WALKED_AFTER = WALKED
  `)

  assert.equal(lua.get('STEP'), 'fleeing', '点着后必须进入 fleeing 阶段')
  const before = Number(lua.get('WALKED_BEFORE'))
  const after = Number(lua.get('WALKED_AFTER'))
  assert.ok(after > before, '撤离阶段必须真的调用走位（GoToPoint），不能原地站着')
})
