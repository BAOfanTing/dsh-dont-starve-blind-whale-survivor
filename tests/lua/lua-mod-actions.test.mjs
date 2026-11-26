// Lua 模组 Nearby ID 复用、范围采集、配方查询与探测动作集成测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { loadMod, ENT_HELPER } from '../helpers/lua-mod-harness.mjs'

test('附近内容没变 → Nearby 快照 ID 复用（否则模型手里的 #N 必然过期）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    NEARBY = { BUSH }
  `, '放一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_A = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    ID_B = Whale.nearby.Observe(ACTOR, {}, 1.5, opts).snapshot_id
    ID_C = Whale.nearby.Observe(ACTOR, {}, 5, opts).snapshot_id
  `)
  const a = global('ID_A')
  assert.ok(a, '应该拿到 snapshot_id')
  assert.equal(global('ID_B'), a, '内容没变时第二次必须复用同一个 id（真机就栽在这）')
  assert.equal(global('ID_C'), a, '第三次也一样')
})

test('附近内容变了 → 换新编号（stale_snapshot 没有被放宽）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    BUSH2 = mkent("berrybush", 3, 24, 0)
    NEARBY = { BUSH }
  `, '一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_1 = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    NEARBY = { BUSH, BUSH2 }        -- 多了一丛：编号必须换
    ID_2 = Whale.nearby.Observe(ACTOR, {}, 2, opts).snapshot_id
    local ent, why = Whale.nearby.Resolve(ID_1, "#1")
    OLD_WHY = why
  `)
  assert.notEqual(global('ID_2'), global('ID_1'), '内容变了必须换编号')
  assert.equal(global('OLD_WHY'), 'stale_snapshot', '旧编号必须失效（fail-closed 没变）')
})

test('实体只是移动了 → 也换新编号（位置进了指纹）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    NEARBY = { BUSH }
  `, '一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_1 = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    BUSH._x = BUSH._x + 8          -- 挪了 2 格
    ID_2 = Whale.nearby.Observe(ACTOR, {}, 2, opts).snapshot_id
  `)
  assert.notEqual(global('ID_2'), global('ID_1'), '位置变了必须换编号（引用的是"那一格的东西"）')
})

test('普通生物只是移动 → 编号不换（红雀乱飞不该让 #N 全部作废）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    ROBIN = mkcreature("robin", 5, 20, 0)
    NEARBY = { ROBIN }
  `, '一只红雀')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_1 = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    ROBIN._x = ROBIN._x + 8        -- 飞了 2 格
    ID_2 = Whale.nearby.Observe(ACTOR, {}, 2, opts).snapshot_id
  `)
  assert.equal(global('ID_2'), global('ID_1'), '普通生物移动不算内容变化（否则鸟一飞 #N 就全废）')
})

test('gather_area 目标太远时先走过去，不许隔着老远推动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 玩家在 (12*4+2, 45*4+2)；把这丛浆果放到 20 格（80 单位）之外
  run(`
    FAR = mkent("berrybush", 77, 12 * 4 + 2 + 80, 45 * 4 + 2)
    NEARBY = { FAR }
  `, '远处放一丛浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    MOVED_TO = nil
    local ctx = { survival_area = true, radius = 12, limit = 3 }
    local started, err = Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-far", ctx)
    assert(started == true, "应该能开始：" .. tostring(err))
    Whale.actions.Tick()
    -- 注意：fengari 的 global() 读 Lua 布尔拿到的不一定是 JS 布尔，统一转成字符串比
    OUT_NO_PUSH = tostring(PUSHED == nil)   -- 关键：不许推
    OUT_MOVED = tostring(MOVED_TO ~= nil)   -- 应该去走
    OUT_HAS_JOB = tostring(Whale.job ~= nil)

  `)
  assert.equal(global('OUT_NO_PUSH'), 'true', '离 20 格远时不该推动作（真机就是这么砍空气的）')
  assert.equal(global('OUT_MOVED'), 'true', '应该往目标走（GoToPoint）')
  assert.equal(global('OUT_HAS_JOB'), 'true', '任务应该还挂着')
})

test('OBS2-5：gather_area 一个都没采到 → 报失败，不许报"做完了"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    -- 就在脚边，但"现在不能采"（CanBePicked=false → not_ready）
    BUSH = mkent("berrybush", 5, 12 * 4 + 2 + 4, 45 * 4 + 2, false)
    NEARBY = { BUSH }
  `, '放一丛没成熟的浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 3 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-none", ctx)
    for i = 1, 30 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_NO_PUSH = tostring(PUSHED == nil)
  `)
  assert.equal(global('OUT_OK'), 'false', '一个都没采到必须是失败（不能让 dispatcher 报"做完了但没核对上"）')
  assert.equal(global('OUT_NO_PUSH'), 'true', '没成熟的东西不该被推去采')
  const text = String(global('OUT_TEXT'))
  assert.match(text, /采了 0 个/, '失败文案要说清采了 0 个')
  assert.match(text, /not_ready|没成熟|够不着/, `失败文案要讲原因，实际：${text}`)
})

// ═══════════ SURVIVAL-08：recipes 崩溃 + 多步动作超预算 ═══════════

test('recipes 不再崩（真机是 U.g 不存在 → attempt to call field g）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run('NEARBY = {}', '附近空')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    -- 假 builder 默认没有 CanBuild（真机有）；这里补上，让"能做/差材料"两条路都走到
    local p = GLOBAL.AllPlayers[1]
    p.components.builder.CanBuild = function(self, name) return name == "torch" end
    local ctx = { limit = 10 }
    local started, err = Whale.actions.Start("recipes", { limit = 10 }, "c-recipes", ctx)
    assert(started == true, "recipes 应该能开始：" .. tostring(err))
    for i = 1, 10 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.equal(global('OUT_OK'), 'true', `recipes 不该报错，实际：${global('OUT_TEXT')}`)
  const text = String(global('OUT_TEXT'))
  assert.match(text, /torch/, '应该列出 STUB 里的 torch 配方')
  assert.match(text, /campfire/, '应该列出 campfire')
  assert.match(text, /能做|差材料|科技/, '每条要带状态')
  assert.ok(!/attempt to call/.test(text), '不许再出现 U.g 那种崩溃')
})

test('S8-2：lookup 也不崩，并且会说"还差什么材料"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run('NEARBY = {}', '附近空')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    local p = GLOBAL.AllPlayers[1]
    p.components.builder.CanBuild = function(self, name) return false end
    local ctx = { lookup_query = "torch" }
    Whale.actions.Start("lookup", { q = "torch" }, "c-lookup", ctx)
    for i = 1, 10 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.equal(global('OUT_OK'), 'true', `lookup 不该报错，实际：${global('OUT_TEXT')}`)
  const text = String(global('OUT_TEXT'))
  assert.match(text, /torch/, '要提到 torch')
  assert.ok(!/attempt to call/.test(text), '不许出现崩溃')
})

test('多步动作超过外层预算 → 自己收尾报 budget_exceeded，不许被砍成 result_timeout', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 目标在 20 格外：gather_area 会一直走，不会自然结束
  run(`
    FAR = mkent("berrybush", 91, 12 * 4 + 2 + 80, 45 * 4 + 2)
    NEARBY = { FAR }
  `, '远处放一丛浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    -- 注意：U.now() 只在 TheSim:GetTime() > 0 时才用它（否则回退到系统时钟）。
    -- 所以先把 NOW 设成正数，后面推进它才有效 —— 否则测的是墙钟、推进 NOW 毫无作用。
    NOW = 100
    -- 外层只给 1 秒预算（真机是 120 秒外层 / 240 秒内层，必然被砍）
    local ctx = { survival_area = true, radius = 12, limit = 3, budget_s = 1 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-budget", ctx)
    Whale.actions.Tick()          -- start → next → 走路
    OUT_STILL_RUNNING = tostring(Whale.job ~= nil)
    NOW = NOW + 5                 -- 假装过了 5 秒（超过 1 秒预算）
    Whale.actions.Tick()          -- 这次必须被预算兜底截住
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_JOB_CLEARED = tostring(Whale.job == nil)
  `)
  assert.equal(global('OUT_STILL_RUNNING'), 'true', '第一步应该还在跑（走路中）')
  assert.equal(global('OUT_OK'), 'false', '超预算必须报失败，不能报成功')
  const text = String(global('OUT_TEXT'))
  assert.match(text, /budget_exceeded/, `要说清是超预算，实际：${text}`)
  assert.match(text, /上限 1 秒/, '要报出预算是多少')
  assert.equal(global('OUT_JOB_CLEARED'), 'true', '报完必须把任务清掉，不能挂着')
})

test('预算够用时不该误伤（正常做完就是成功）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 脚边一丛成熟浆果：一次就能采完
  run(`
    NEAR = mkent("berrybush", 92, 12 * 4 + 2 + 4, 45 * 4 + 2)
    NEAR.components.pickable.CanBePicked = function() return true end
    NEAR.components.pickable.Pick = function() end
    NEARBY = { NEAR }
  `, '脚边放一丛成熟浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 1, budget_s = 60 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 1 }, "c-ok", ctx)
    for i = 1, 40 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
        -- 采完之后 CanBePicked 变 false（模拟真机），推进状态机
        if BUFFERED ~= nil or PUSHED ~= nil then
            NEAR.components.pickable.CanBePicked = function() return false end
        end
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  const text = String(global('OUT_TEXT'))
  assert.ok(!/budget_exceeded/.test(text), `预算充足时不该报超预算，实际：${text}`)
  // ★ 这几条是补上的：原来只查"不是超预算"，结果漏掉了真机的崩溃
  //   （current 存了候选表 → cur:IsValid() → attempt to call method 'IsValid'）
  assert.equal(global('OUT_OK'), 'true', `脚边有成熟浆果时必须采成功，实际：${text}`)
  assert.match(text, /采了 [1-9]/, `要真的采到，实际：${text}`)
  assert.ok(!/attempt to call/.test(text), `不许出 Lua 崩溃，实际：${text}`)
  assert.ok(!/动作出错/.test(text), `不许报"动作出错"，实际：${text}`)
})

test('目标就在脚边（不走 walking 直接 acting）也不能崩 —— 真机 Cluster_1 的崩溃点', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 距离 1 格（4 单位）：远小于 APPROACH_UNITS(6.4) → next 直接进 acting
  run(`
    NEAR = mkent("berrybush", 93, 12 * 4 + 2 + 4, 45 * 4 + 2)
    NEAR.components.pickable.CanBePicked = function() return true end
    NEARBY = { NEAR }
  `, '脚边 1 格放一丛成熟浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 1, budget_s = 60 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 1 }, "c-near", ctx)
    local pushed_once = false
    for i = 1, 40 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
        if PUSHED ~= nil and not pushed_once then
            pushed_once = true
            PUSHED_TARGET_OK = tostring(PUSHED.target ~= nil and PUSHED.target.prefab == "berrybush")
            -- 采成功：CanBePicked 翻成 false
            NEAR.components.pickable.CanBePicked = function() return false end
        end
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_PUSHED = tostring(pushed_once)
  `)
  assert.equal(global('OUT_PUSHED'), 'true', '应该真的推了 PICK 动作')
  assert.equal(global('PUSHED_TARGET_OK'), 'true', '推的动作目标要对着那丛浆果')
  assert.equal(global('OUT_OK'), 'true', `不该崩、应该采成功，实际：${global('OUT_TEXT')}`)
  assert.ok(!/attempt to call/.test(String(global('OUT_TEXT'))), '不许出 IsValid 那类崩溃')
})

test('S8-6：范围内没成熟目标时，失败消息必须告诉模型"最近能采的多远、radius 调多大"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 脚边一丛"还没长好"，10 格外一丛"成熟" —— 半径 6 内一个能采的都没有
  run(`
    NOT_READY = mkent("berrybush", 95, 12 * 4 + 2 + 12, 45 * 4 + 2, false)
    READY_FAR = mkent("berrybush", 96, 12 * 4 + 2 + 40, 45 * 4 + 2, true)
    NEARBY = { NOT_READY, READY_FAR }
    GLOBAL.TheSim.FindEntities = function(self, x, y, z, radius)
        local found = {}
        for _, ent in ipairs(NEARBY) do
            if (ent._x - x)^2 + (ent._z - z)^2 <= radius^2 then
                found[#found + 1] = ent
            end
        end
        return found
    end
    NOW = 100
  `, '脚边没熟、10 格外有熟的')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 6, limit = 1, budget_s = 300 }
    local started, serr = Whale.actions.Start("gather_area", { radius = 6, limit = 1 }, "c-hint", ctx)
    assert(started == true, "应该能开始：" .. tostring(serr))
    for i = 1, 60 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
        NOW = NOW + 3
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.equal(global('OUT_OK'), 'false', '范围内没熟的，不该报成功')
  const text = String(global('OUT_TEXT'))
  assert.match(text, /采了 0 个/, `要说清采了 0 个，实际：${text}`)
  // ★ 关键的"可操作信息"：模型正是缺这个才反复换小半径重试
  assert.match(text, /radius/, `要告诉模型 radius 该调多大，实际：${text}`)
  assert.match(text, /1[0-9](\.\d)? 格|格/, `要报出最近能采的有多远，实际：${text}`)
  assert.ok(!/no_targets_in_range/.test(text), '不该再出现那句没有指导意义的 no_targets_in_range')
})

const AREA_MOVEMENT_HELPER = `
    NOW = 100
    MOVE_STATE = "idle"
    HARD_BUSY = false
    BERRY_COUNT = 6
    PICK_COUNT = 0
    local p = GLOBAL.AllPlayers[1]
    local loco = p.components.locomotor
    p.components.inventory._items[1].components.stackable.StackSize = function() return BERRY_COUNT end
    p.sg.HasStateTag = function(self, tag)
        return tag == MOVE_STATE or (tag == "busy" and (HARD_BUSY or MOVE_STATE == "picking"))
    end
    loco.GoToPoint = function(self, pt)
        self.dest = pt
        MOVED_TO = pt
        MOVE_STATE = "moving"
    end
    loco.Stop = function(self)
        self.dest = nil
        MOVE_STATE = "idle"
    end
    loco.Clear = function(self)
        self.dest = nil
        self.bufferedaction = nil
    end
    loco.PushAction = function(self, ba)
        self:Clear()
        self.bufferedaction = ba
        PUSHED = ba
        PICK_COUNT = PICK_COUNT + 1
        MOVE_STATE = "moving"
    end
    function advance_gather()
        if BUFFERED ~= nil then
            BUFFERED.target.components.pickable.CanBePicked = function() return false end
            BERRY_COUNT = BERRY_COUNT + 1
            BUFFERED = nil
            MOVE_STATE = "idle"
        elseif loco.bufferedaction ~= nil then
            local target = loco.bufferedaction.target
            p._x, p._z = target._x - 1, target._z
            BUFFERED = loco.bufferedaction
            loco.bufferedaction = nil
            MOVE_STATE = "picking"
        elseif loco.dest ~= nil then
            p._x, p._z = loco.dest.x - 1, loco.dest.z
        end
        NOW = NOW + 0.5
    end
    Whale.bridge = {
        Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
        WriteState = function() end,
    }
`

test('AREA-1：走到浆果丛旁仍是 moving 时，交给原生 PICK 并连续采到五份浆果', async () => {
  const { run, runFile, global } = loadMod(await import('fengari'))
  run(ENT_HELPER, '实体辅助')
  run(AREA_MOVEMENT_HELPER, '移动与采摘状态')
  runFile(`
    local p = GLOBAL.AllPlayers[1]
    NEARBY = {}
    for i = 1, 5 do
        local bush = mkent("berrybush", 100 + i, p._x + 20 + i * 4, p._z)
        bush.components.pickable.product = "berries"
        NEARBY[i] = bush
    end
    local args = { prefab = "berrybush", radius = 16, limit = 5 }
    local ctx = { survival_area = true, prefab = "berrybush", radius = 16, limit = 5, budget_s = 105 }
    assert(Whale.actions.Start("gather_area", args, "c-five", ctx))
    for i = 1, 80 do
        Whale.actions.Tick()
        if Whale.job == nil then break end
        advance_gather()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or "未结束"
    OUT_GAINED = tostring(BERRY_COUNT - 6)
    OUT_PUSHES = tostring(PICK_COUNT)
    OUT_CLEARED = tostring(Whale.job == nil and p.components.locomotor.dest == nil
        and p.components.locomotor.bufferedaction == nil and BUFFERED == nil)
  `)
  assert.equal(global('OUT_OK'), 'true', global('OUT_TEXT'))
  assert.equal(global('OUT_GAINED'), '5')
  assert.equal(global('OUT_PUSHES'), '5', '每丛只推一次，不靠重复推送撞运气')
  assert.match(global('OUT_TEXT'), /采了 5 个（berries\+5）/)
  assert.equal(global('OUT_CLEARED'), 'true')
})

test('AREA-2：next 阶段就在目标旁，普通行走也不能挡住采摘', async () => {
  const { run, runFile, global } = loadMod(await import('fengari'))
  run(ENT_HELPER, '实体辅助')
  run(AREA_MOVEMENT_HELPER, '移动与采摘状态')
  runFile(`
    local p = GLOBAL.AllPlayers[1]
    NEARBY = { mkent("berrybush", 110, p._x + 4, p._z) }
    MOVE_STATE = "moving"
    Whale.actions.Start("gather_area", {}, "c-near-moving", { survival_area = true, limit = 1 })
    Whale.actions.Tick()
    OUT_PICK = tostring(PUSHED ~= nil and PUSHED.action == GLOBAL.ACTIONS.PICK)
  `)
  assert.equal(global('OUT_PICK'), 'true')
})

for (const phase of ['next', 'walking']) {
  for (const blocker of ['HARD_BUSY = true', 'BUFFERED = {}', 'loco.bufferedaction = {}']) {
    test(`AREA-3：${phase} 不能覆盖真实忙碌或排队动作（${blocker}）`, async () => {
      const { run, runFile, global } = loadMod(await import('fengari'))
      run(ENT_HELPER, '实体辅助')
      run(AREA_MOVEMENT_HELPER, '移动与采摘状态')
      runFile(`
        local p = GLOBAL.AllPlayers[1]
        local loco = p.components.locomotor
        local bush = mkent("berrybush", 111, p._x + 24, p._z)
        NEARBY = { bush }
        Whale.actions.Start("gather_area", {}, "c-busy", { survival_area = true, limit = 1 })
        if "${phase}" == "walking" then
            Whale.actions.Tick()
            p._x = bush._x - 1
        end
        MOVE_STATE = "moving"
        ${blocker}
        MOVED_TO = nil
        Whale.actions.Tick()
        OUT_WAIT = tostring(PUSHED == nil and MOVED_TO == nil)
        HARD_BUSY = false
        BUFFERED = nil
        loco.bufferedaction = nil
        p._x = bush._x - 1
        Whale.actions.Tick()
        OUT_RESUMED = tostring(PUSHED ~= nil)
      `)
      assert.equal(global('OUT_WAIT'), 'true', '不得覆盖忙碌动作或其移动目标')
      assert.equal(global('OUT_RESUMED'), 'true', '忙碌结束后应继续采摘')
    })
  }
}

test('AREA-4：一丛采摘超时后清掉旧动作，继续采下一丛', async () => {
  const { run, runFile, global } = loadMod(await import('fengari'))
  run(ENT_HELPER, '实体辅助')
  run(AREA_MOVEMENT_HELPER, '移动与采摘状态')
  runFile(`
    local p = GLOBAL.AllPlayers[1]
    local blocked = mkent("berrybush", 112, p._x + 4, p._z)
    local reachable = mkent("berrybush", 113, p._x + 6, p._z)
    reachable.components.pickable.product = "berries"
    NEARBY = { blocked, reachable }
    Whale.actions.Start("gather_area", {}, "c-recover", { survival_area = true, limit = 1, budget_s = 60 })
    for i = 1, 60 do
        Whale.actions.Tick()
        if Whale.job == nil then break end
        local queued = p.components.locomotor.bufferedaction or BUFFERED
        if queued ~= nil and queued.target == blocked then
            BUFFERED = queued
            MOVE_STATE = "picking"
            NOW = NOW + 0.5
        else
            advance_gather()
        end
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or "未结束"
    OUT_GAINED = tostring(BERRY_COUNT - 6)
    OUT_PUSHES = tostring(PICK_COUNT)
  `)
  assert.equal(global('OUT_OK'), 'true', global('OUT_TEXT'))
  assert.equal(global('OUT_GAINED'), '1')
  assert.equal(global('OUT_PUSHES'), '2')
  assert.match(global('OUT_TEXT'), /1 个没采成/)
})

for (const budget of [1, 60]) {
  test(`AREA-5：走不到目标时清理移动，不建议重试失败目标（预算 ${budget} 秒）`, async () => {
    const { run, runFile, global } = loadMod(await import('fengari'))
    run(ENT_HELPER, '实体辅助')
    run(AREA_MOVEMENT_HELPER, '移动与采摘状态')
    runFile(`
      local p = GLOBAL.AllPlayers[1]
      NEARBY = { mkent("berrybush", 114, p._x + 24, p._z) }
      Whale.actions.Start("gather_area", {}, "c-unreachable", { survival_area = true, limit = 1, budget_s = ${budget} })
      for i = 1, 8 do
          Whale.actions.Tick()
          if Whale.job == nil then break end
          NOW = NOW + 5
      end
      OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok)
      OUT_TEXT = REPORTED ~= nil and REPORTED.text or "未结束"
      OUT_STOPPED = tostring(Whale.job == nil and p.components.locomotor.dest == nil
          and p.components.locomotor.bufferedaction == nil and BUFFERED == nil and MOVE_STATE == "idle")
    `)
    assert.equal(global('OUT_OK'), 'false', global('OUT_TEXT'))
    assert.equal(global('OUT_STOPPED'), 'true', '失败回执之前必须真正停止旧的移动')
    assert.doesNotMatch(global('OUT_TEXT'), /把 radius 调到|都还没长好/)
  })
}

test('S8-7：guard 不再用"范围内没成熟目标"拒绝（那是便利判断，不是安全校验）', () => {
  const guard = readFileSync(new URL('../../DontStarveWhaleSurvivor/scripts/whale/guard.lua', import.meta.url), 'utf8')
  const code = guard.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
  assert.ok(!/return false, "no_targets_in_range"/.test(code),
    'guard 里不该再有 no_targets_in_range 的硬拒绝（改成让任务跑起来、由任务给出可操作原因）')
  // 但安全校验必须还在（别顺手删多了）
  assert.match(code, /prefab_not_allowed/, 'gather_area 的 prefab 白名单校验必须还在')
  assert.match(code, /actor_busy/, 'actor_busy 校验必须还在')
})

test('PROBE-1：probe 返回的格坐标 (tx, tz) 能正确读取 z 轴（不会恒为 0）', async () => {
  const { run, runFile, global } = loadMod(await import('fengari'))
  run(ENT_HELPER, '实体辅助')
  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    local p = GLOBAL.AllPlayers[1]
    p._x, p._z = 100, 200
    p.Transform = { GetWorldPosition = function() return p._x, 0, p._z end }
    NEARBY = { mkent("berrybush", 101, 120, 240) }
    Whale.actions.Start("probe", {}, "c-probe", { probe_prefab = "berrybush", probe_radius = 40 })
    Whale.actions.Tick()
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or "未结束"
  `)
  assert.equal(global('OUT_OK'), 'true')
  assert.match(global('OUT_TEXT'), /\(30,60\)/, 'tz 应该基于真实的 z 坐标（60），不该恒为 0')
})

test('RECIPE-ALIAS-1：chest 和 sciencemachine 能正确解析到原生配方与建筑名', async () => {
  const { run, runFile, global } = loadMod(await import('fengari'))
  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    GLOBAL.AllRecipes.treasurechest = { name = "treasurechest", placer = "treasurechest_placer", ingredients = {} }
    GLOBAL.AllRecipes.researchlab = { name = "researchlab", placer = "researchlab_placer", ingredients = {} }

    Whale.actions.Start("lookup", {}, "c-lookup-chest", { lookup_query = "chest" })
    Whale.actions.Tick()
    OUT_LOOKUP_CHEST = REPORTED ~= nil and REPORTED.text or ""

    Whale.actions.Start("lookup", {}, "c-lookup-sm", { lookup_query = "sciencemachine" })
    Whale.actions.Tick()
    OUT_LOOKUP_SM = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.match(global('OUT_LOOKUP_CHEST'), /配方 chest|treasurechest/, 'chest 应该解析到 treasurechest')
  assert.match(global('OUT_LOOKUP_SM'), /配方 sciencemachine|researchlab/, 'sciencemachine 应该解析到 researchlab')
})

