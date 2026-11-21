// 砍树/挖矿的执行细节（TARGET-REFRESH 补测）
//
// 为什么要有这个文件：
//   真机里 `chop_nearest {"target_kind":"tree"}` 只砍了**一下**就停住，然后干等到 120 秒超时
//   （日志：`DONE #9 chop_nearest FAIL status=unknown reason=result_timeout 120123ms`）。
//   根因：`work_by_ref`（chop_nearest / chop / mine / dig / hammer 走的新路径）在 start 阶段
//   **只 push 一次** BufferedAction 就干等 —— 可树要 4~5 下才倒、石头要挖好几下，
//   永远等不到 `work_done`，最后超时。旧路径 `job_work` 早就有连砍机制，新路径漏了。
//
// 证据类型：INTEGRATION（fengari 跑真实 actions/work.lua 的 work_by_ref；假实体）
//
// ★ 夹具注意：`gathering.lua` 在**加载时**就 `local push = A.push` / `local hold_control = A.hold_control`
//   捕获了原函数，所以运行时改 `Whale.actions.push` 是无效的。要观察"砍了几下"，
//   包 `GLOBAL.BufferedAction`（每次构造动作 = 引擎演一下）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MOD, loadTargets } from './target-harness.mjs'

const gatheringLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'work.lua'), 'utf8')

/**
 * 造一棵"要砍 N 下才倒"的树。
 * 用 metatable 模拟原生 workable：读 workleft / 砍一下 -1 / 归零变树桩（action 变 DIG）。
 * `hit` 必须挂在表本身上（metatable 的 __index 只处理"读"）。
 */
const treeLua = (hitsLeft = 4) => `
  (function()
    local e = mkent({ prefab = "evergreen", guid = 601, x = 2, z = 0, work = "CHOP" })
    local left = ${hitsLeft}
    local action = { id = "CHOP" }
    local w = {}
    function w.hit() left = left - 1; if left <= 0 then action = { id = "DIG" } end end
    setmetatable(w, {
      __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil
      end,
    })
    e.components.workable = w
    return e
  end)()
`

/** 假斧头：best_tool 靠 components.tool:CanDoAction(action) 挑工具 */
const axeLua = `
  AXE = mkent({ prefab = "axe", guid = 700, x = 0, z = 0, pickup = true })
  AXE.components.finiteuses = { GetUses = function() return 100 end, GetPercent = function() return 1 end }
  AXE.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "CHOP" end }
  ITEMS = { AXE }
  PLAYER.components.inventory.GetEquippedItem = function() return AXE end
  PLAYER.components.inventory.Equip = function() end
  -- hold_control 要往这里写"按住动作键"
  PLAYER.components.playercontroller = { remote_controls = {} }
`

/**
 * 在**模块加载前**包好 BufferedAction：每次构造动作 = 引擎砍一下，并计数。
 * 必须用 preload（加载后再改无效，见文件头说明）。
 * 实体在 preload 之后才创建，所以这里用全局名延迟查表。
 */
/**
 * 在**模块加载前**装好"引擎真的被推了一次"的钩子。
 *
 * ★ 为什么钩 `loco:PushAction` 而不是 `BufferedAction`：
 *   兜底重推是**复用**同一个 `j.data.ba`（重建会打断 sg 状态机），所以 BufferedAction 的
 *   构造次数只有 1 次 —— 拿它当"砍了几下"会误判成"只砍一下"。
 *   真正"砍一下"的是 push（`loco:PushAction`）。
 */
const hitPreload = (entGlobalName, counterName) => `
  ${counterName} = 0
  HIT_ENTITY_NAME = ${JSON.stringify(entGlobalName)}
  HIT_COUNTER_NAME = ${JSON.stringify(counterName)}
  -- PLAYER 在 STUB 里已经建好了，这里直接包它的 PushAction：
  -- 每次 PushAction = 引擎真的演一下（这才是"砍了一下"）
  local real_push_action = PLAYER.components.locomotor.PushAction
  PLAYER.components.locomotor.PushAction = function(self, ba, run)
    _G[HIT_COUNTER_NAME] = (_G[HIT_COUNTER_NAME] or 0) + 1
    local e = _G[HIT_ENTITY_NAME]
    if e ~= nil and e.components ~= nil and e.components.workable ~= nil
       and e.components.workable.hit ~= nil then
      e.components.workable.hit()
    end
    return real_push_action(self, ba, run)
  end
`

test('CHOP-1（INTEGRATION）：一棵要砍 4 下的树 —— 必须连砍到倒，不能只砍一下干等', async () => {
  const env = await loadTargets({ preload: hitPreload('TREE', 'PUSHES') })
  env.run(`
    TREE = ${treeLua(4)}
    WORLD = { TREE }
    ${axeLua}
    
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-chop", { target = TREE })
    for i = 1, 40 do
      NOW = NOW + 0.6          -- 推进游戏时间：兜底重推有 0.5 秒节流
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    HELD = PLAYER.components.playercontroller.remote_controls[GLOBAL.CONTROL_ACTION] == true
    OUT = tostring(PUSHES) .. "|" .. tostring(HELD) .. "|" .. tostring(TREE.components.workable.workleft)
  `)
  const rep = env.report()
  const [pushesRaw, heldRaw, leftRaw] = env.get('OUT').split('|')
  const pushes = Number(pushesRaw)
  // 树要 4 下：至少要 push 4 次才可能砍倒（这就是"只砍一下"的回归点）
  assert.ok(pushes >= 4, `应该连砍至少 4 下，实际只 push 了 ${pushes} 次（回执：${rep.text}）`)
  assert.equal(leftRaw, '0', '砍完之后 workleft 应该归零（树倒了）')
  assert.equal(heldRaw, 'false', '砍倒之后必须松手，否则会一路砍到下一棵')
  // 砍倒之后必须报成功，并且回执里带上目标名
  assert.match(String(rep.text), /砍了|干倒|常青树/, `回执要说明砍倒了，实际 ${rep.text}`)
})

test('CHOP-2（INTEGRATION）：树没倒时 job 必须还在跑（不能谎报完成）', async () => {
  // 反向验证：用一棵"要砍 99 下"的树，确认代码**不会**因为"推过一次"就报 done。
  const env = await loadTargets({ preload: hitPreload('TREE', 'PUSHES') })
  env.run(`
    TREE = ${treeLua(99)}
    WORLD = { TREE }
    ${axeLua}
    
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-chop2", { target = TREE })
    for i = 1, 6 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(Whale.actions.Current() ~= nil) .. "|" .. tostring(PUSHES)
  `)
  const [stillRunning, pushesRaw] = env.get('OUT').split('|')
  assert.equal(stillRunning, 'true', '树没倒时 job 必须还在跑（不能谎报完成）')
  assert.ok(Number(pushesRaw) >= 2, `应该持续在砍，实际 push ${pushesRaw} 次`)
})

test('CHOP-3（INTEGRATION）：没有工具时立刻说 no_tool，不要空砍 120 秒', async () => {
  const env = await loadTargets({ preload: hitPreload('TREE', 'PUSHES') })
  env.run(`
    TREE = ${treeLua(4)}
    WORLD = { TREE }
    ITEMS = {}
    PLAYER.components.inventory.GetEquippedItem = function() return nil end
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-chop3", { target = TREE })
    for i = 1, 5 do
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
  `)
  const rep = env.report()
  assert.match(String(rep.text), /no_tool/, `应该立刻报 no_tool，实际 ${rep.text}`)
  assert.match(String(rep.text), /craft axe|斧头/, '要告诉模型先做斧头')
})

test('CHOP-4：源码层面确认连砍机制在（hold_control + 复用 BufferedAction + 兜底重推）', () => {
  // 盯四件事：① 按住动作键 ② 复用同一个 ba（重建会打断 sg 状态机）③ 不忙时自己重推 ④ 数砍了几下
  const workFn = gatheringLua.slice(gatheringLua.indexOf('local function work_by_ref'))
  assert.match(workFn, /hold_control\(p, true\)/, 'start 之后要按住动作键（引擎自己连砍）')
  assert.match(workFn, /hold_control\(p, false\)/, '目标倒了要松手')
  assert.match(workFn, /j\.data\.ba = ba/, '要保存 BufferedAction 以便复用')
  assert.match(workFn, /ba\.doable = nil/, '复用前要清 doable（否则重放会被拒）')
  assert.match(workFn, /not busy\(p\)/, '兜底：不忙时自己重推')
  assert.match(workFn, /j\.data\.hits/, '要数砍了几下（防止无限空砍）')
  // 顺序：先判"目标倒没倒"，再判忙不忙（引擎连砍时人物一直 busy）
  // 判顺序前先剥掉注释行 —— 否则注释里提到 `not busy(p)` 会把 indexOf 骗到前面去
  const workCode = workFn.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  const doneIdx = workCode.indexOf('work_done(target, def.action)')
  const busyIdx = workCode.indexOf('not busy(p)')
  assert.ok(doneIdx > 0 && busyIdx > doneIdx, '必须先判目标倒没倒，再判忙不忙')
})

test('CHOP-6（INTEGRATION）：目标太远时要说"先靠近"，不能误报成"工具不对/推不动"', async () => {
  // 真机踩到：桦栗树在 2 格外，引擎要先走过去；3 秒阈值不够 →
  // 回执被误报成「推不动 桦栗树…可能工具不对或者够不着」，模型会以为要换工具。
  const env = await loadTargets({})
  env.run(`
    TREE = ${treeLua(4)}
    -- 把树挪到 3 格外（12 世界单位）
    TREE.Transform = { GetWorldPosition = function() return 12, 0, 0 end }
    WORLD = { TREE }
    ${axeLua}
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-far", { target = TREE })
    for i = 1, 6 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
  `)
  const rep = env.report()
  const text = String(rep.text)
  assert.match(text, /out_of_range/, `太远应该报 out_of_range，实际 ${text}`)
  assert.match(text, /move_to/, `要告诉模型先 move_to，实际 ${text}`)
  assert.match(text, /格外/, `要说清还差几格，实际 ${text}`)
  assert.doesNotMatch(text, /推不动/, `不能误报"推不动"，实际 ${text}`)
})

test('CHOP-7（INTEGRATION）：距离够、工具对 → 不会被"推不动"提前打断', async () => {
  const env = await loadTargets({})
  env.run(`
    TREE = ${treeLua(99)}
    WORLD = { TREE }
    ${axeLua}
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-near", { target = TREE })
    for i = 1, 5 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(Whale.actions.Current() ~= nil)
  `)
  assert.equal(env.get('OUT'), 'true', '贴身的树不该被"推不动"打断（job 应该还在跑）')
})

test('CHOP-8（INTEGRATION）：树砍倒后变成树桩（action 变 DIG）→ 必须判"砍完了"，不能报推不动', async () => {
  // 真机踩到：树砍倒后 workleft 不一定变 0，而是**变成树桩**（workable.action 从 CHOP 变 DIG）。
  // 只看 workleft 会判"没砍完" → 树倒了、木头都掉了，回执却报「推不动 常青树」。
  const env = await loadTargets({})
  env.run(`
    TREE = (function()
      local e = mkent({ prefab = "evergreen", guid = 601, x = 2, z = 0, work = "CHOP" })
      local left = 4
      local action = { id = "CHOP" }
      local w = {}
      -- 砍倒：**只**把 action 变 DIG（树桩），workleft 故意保持不变。
      -- 真机形态：树倒后 workleft 不一定归零，判"砍完"必须靠 action 变化。
      function w.hit() action = { id = "DIG" } end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    WORLD = { TREE }
    -- 在 push 的那一刻调 hit()（PLAYER 已存在，包 PushAction 即可）
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      TREE.components.workable.hit()
      return real_pa(self, ba, run)
    end
    ${axeLua}
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-stump", { target = TREE })
    for i = 1, 40 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(TREE.components.workable.workleft) .. "|" .. tostring(TREE.components.workable.action.id)
  `)
  const rep = env.report()
  const text = String(rep.text)
  const [left, act] = env.get('OUT').split('|')
  // 前提确认：确实变成了树桩，而且 workleft 没归零
  assert.equal(act, 'DIG', '目标应该变成树桩（action=DIG）')
  assert.notEqual(left, '0', '这个夹具故意让 workleft 不归零（真机形态）')
  // 关键：不能报"推不动"
  assert.doesNotMatch(text, /推不动/, `树桩不该报推不动，实际 ${text}`)
  assert.match(text, /砍了|常青树/, `应该报砍倒了，实际 ${text}`)
})

test('CHOP-9（INTEGRATION）：砍倒后要顺手把脚下掉出来的产物捡起来（不然模型以为木头已进包）', async () => {
  // 真机踩到：树砍倒了、木头就掉在 0.3 格外，但回执只说"砍了常青树"，
  // 模型以为东西已经到手，于是没去捡 —— 用户看到的就是"砍了但没捡木头"。
  const env = await loadTargets({ preload: hitPreload('TREE', 'PUSHES') })
  env.run(`
    TREE = (function()
      local e = mkent({ prefab = "evergreen", guid = 601, x = 2, z = 0, work = "CHOP" })
      local left = 2
      local action = { id = "CHOP" }
      local w = {}
      function w.hit() left = left - 1; if left <= 0 then action = { id = "DIG" } end end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    -- 砍倒之后脚下出现两根木头（真机：lootdropper 把 log 掉在地上）
    LOG1 = mkent({ prefab = "log", guid = 801, x = 2, z = 0, pickup = true })
    LOG2 = mkent({ prefab = "log", guid = 802, x = 2, z = 0, pickup = true })
    WORLD = { TREE }
    ${axeLua}
    PICKED_UP = {}
    -- 捡起 = 从世界移除 + 记一笔（真机里 ACTIONS.PICKUP 会把物品拿进背包、离开地面）
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      if ba ~= nil and ba.action ~= nil and ba.action.id == "PICKUP" and ba.target ~= nil then
        local t = ba.target
        PICKED_UP[#PICKED_UP + 1] = tostring(t.prefab)
        for i = #WORLD, 1, -1 do if WORLD[i] == t then table.remove(WORLD, i) end end
        -- 模拟"进背包"：把物品标成 limbo，这样 IsCandidate 不会再把它当可捡
        t.limbo = true
      end
      return real_pa(self, ba, run)
    end
  `)
  env.buildNearby()
  env.run(`
    -- 砍的过程中把木头放进世界（模拟 lootdropper 掉落）
    local pushed_tree = false
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-loot", { target = TREE })
    for i = 1, 40 do
      NOW = NOW + 0.6
      if not pushed_tree and TREE.components.workable.action.id == "DIG" then
        WORLD[#WORLD + 1] = LOG1
        WORLD[#WORLD + 1] = LOG2
        pushed_tree = true
      end
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(#PICKED_UP)
  `)
  const picked = Number(env.get('OUT'))
  assert.ok(picked >= 1, `砍倒后应该顺手捡起脚下的木头，实际捡了 ${picked} 个`)
})

test('CHOP-10（INTEGRATION）：岩石挖碎后**实体直接消失**，也必须进 loot 把石头捡起来', async () => {
  // 真机踩到（用户："我看你能把树砍了啊，就是没捡木头" 的挖矿版）：
  // 岩石一碎 `target:IsValid()` 就是 false，`work_by_ref` 开头那句"目标没了 → done"
  // 会**直接跳过捡东西** → 回执「挖了 岩石」但 rocks/flint/nitre 全躺在地上。
  const env = await loadTargets({})
  env.run(`
    ROCK = (function()
      local e = mkent({ prefab = "rock1", guid = 611, x = 1, z = 0, work = "MINE" })
      local action = { id = "MINE" }
      local w = {}
      -- 挖一下就碎：实体失效 + workable 变 nil（真机形态）
      function w.hit() e.valid = false end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return 1 end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    -- 挖碎后掉在地上的产物
    ROCKS = mkent({ prefab = "rocks", guid = 901, x = 1, z = 0, pickup = true })
    FLINT = mkent({ prefab = "flint", guid = 902, x = 1, z = 0, pickup = true })
    WORLD = { ROCK }
    PICK = mkent({ prefab = "pickaxe", guid = 701, x = 0, z = 0, pickup = true })
    PICK.components.finiteuses = { GetUses = function() return 100 end }
    PICK.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "MINE" end }
    ITEMS = { PICK }
    PLAYER.components.inventory.GetEquippedItem = function() return PICK end
    PLAYER.components.inventory.Equip = function() end
    PLAYER.components.playercontroller = { remote_controls = {} }
    PICKED_UP = {}
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      -- 挖一下就碎，并把产物放进世界（模拟 lootdropper）
      if ROCK.valid then
        ROCK.components.workable.hit()
        WORLD[#WORLD + 1] = ROCKS
        WORLD[#WORLD + 1] = FLINT
      end
      if ba ~= nil and ba.action ~= nil and ba.action.id == "PICKUP" and ba.target ~= nil then
        local t = ba.target
        PICKED_UP[#PICKED_UP + 1] = tostring(t.prefab)
        t.limbo = true
        for i = #WORLD, 1, -1 do if WORLD[i] == t then table.remove(WORLD, i) end end
      end
      return real_pa(self, ba, run)
    end
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("mine", { target_kind = "ordinary_rock" }, "c-mine-gone", { target = ROCK })
    for i = 1, 30 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(#PICKED_UP) .. "|" .. table.concat(PICKED_UP, ",")
  `)
  const [countRaw, names] = env.get('OUT').split('|')
  assert.ok(Number(countRaw) >= 1, `挖碎后必须捡起产物，实际捡了 ${countRaw} 个（${names}）`)
  const rep = env.report()
  assert.match(String(rep.text), /挖了/, `应该报挖开，实际 ${rep.text}`)
})

test('CHOP-11（INTEGRATION）：真机形态 —— 一块岩石掉 rocks+flint+nitre 三样，要全部捡完再收工', async () => {
  // 真机证据（2026-11-16 22:29）：挖碎一块 rock1 之后地上是
  //   flint@0.2 / rocks@0.2 / flint@0.4 / rocks@0.8 / rocks@0.9 / nitre@1.0
  // 回执却只有「挖了 岩石」—— 一样都没捡。这里按同样的形态验：三样都得进背包。
  const env = await loadTargets({})
  env.run(`
    ROCK = (function()
      local e = mkent({ prefab = "rock1", guid = 611, x = 1, z = 0, work = "MINE" })
      local action = { id = "MINE" }
      local w = {}
      function w.hit() e.valid = false end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return 1 end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    WORLD = { ROCK }
    PICK = mkent({ prefab = "pickaxe", guid = 701, x = 0, z = 0, pickup = true })
    PICK.components.finiteuses = { GetUses = function() return 100 end }
    PICK.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "MINE" end }
    ITEMS = { PICK }
    PLAYER.components.inventory.GetEquippedItem = function() return PICK end
    PLAYER.components.inventory.Equip = function() end
    PLAYER.components.playercontroller = { remote_controls = {} }
    PICKED = {}
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      -- 挖一下就碎，一次掉三样（真机 loot table: rocks×3 + flint + nitre）
      if ROCK.valid then
        ROCK.components.workable.hit()
        WORLD[#WORLD + 1] = mkent({ prefab = "flint", guid = 921, x = 1, z = 0, pickup = true })
        WORLD[#WORLD + 1] = mkent({ prefab = "rocks", guid = 922, x = 1, z = 0, pickup = true })
        WORLD[#WORLD + 1] = mkent({ prefab = "nitre", guid = 923, x = 1, z = 0, pickup = true })
      end
      if ba ~= nil and ba.action ~= nil and ba.action.id == "PICKUP" and ba.target ~= nil then
        local t = ba.target
        PICKED[#PICKED + 1] = tostring(t.prefab)
        t.limbo = true
        for i = #WORLD, 1, -1 do if WORLD[i] == t then table.remove(WORLD, i) end end
      end
      return real_pa(self, ba, run)
    end
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("mine", { target_kind = "ordinary_rock" }, "c-mine-all", { target = ROCK })
    for i = 1, 40 do
      NOW = NOW + 0.2          -- 真实 tick 间隔
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    table.sort(PICKED)
    OUT = tostring(#PICKED) .. "|" .. table.concat(PICKED, ",")
  `)
  const [countRaw, names] = env.get('OUT').split('|')
  assert.equal(Number(countRaw), 3, `三样产物都要捡，实际捡了 ${countRaw} 个（${names}）`)
  assert.match(names, /flint/, `要捡到 flint，实际 ${names}`)
  assert.match(names, /rocks/, `要捡到 rocks，实际 ${names}`)
  assert.match(names, /nitre/, `要捡到 nitre，实际 ${names}`)
  // 而且要快：不能每样等 1 秒
  const rep = env.report()
  assert.match(String(rep.text), /挖了/, `回执要报挖开，实际 ${rep.text}`)
})

test('CHOP-12（INTEGRATION）：hold_control 必须写数字 0，不能写布尔（否则真机"停几秒再开始"）', async () => {
  // 真机 bug（2026-11-17，用户："砍树/砸矿都是走到附近，然后停几秒再开始"）：
  // `hold_control` 原来往 playercontroller.remote_controls[CONTROL_ACTION] 写布尔 true，
  // 但引擎把它当**倒计时数字**用：
  //   playercontroller.lua:537  self.remote_controls[k] = math.max(v - dt, 0)
  // 而这一句在 3097 行只要角色"空闲或移动中"就会拿到真实 dt →
  // `true - dt` 抛 "attempt to perform arithmetic on a boolean value"，
  // 打断每帧的控制器收尾循环，角色就杵在原地几秒。
  const env = await loadTargets({})
  env.run(`
    PLAYER.components.playercontroller = { remote_controls = {} }
    Whale.actions.hold_control(PLAYER, true)
    local rc = PLAYER.components.playercontroller.remote_controls
    local v = rc[GLOBAL.CONTROL_ACTION]
    TYPE = type(v)
    VAL = tostring(v)
    -- 复现引擎的 CooldownRemoteController(dt)：布尔在这一步会直接抛错
    local dt = 0.03
    for k, vv in pairs(rc) do rc[k] = math.max(vv - dt, 0) end
    AFTER = tostring(rc[GLOBAL.CONTROL_ACTION])
    Whale.actions.hold_control(PLAYER, false)
    RELEASED = tostring(PLAYER.components.playercontroller.remote_controls[GLOBAL.CONTROL_ACTION])
    OUT = TYPE .. "|" .. VAL .. "|" .. AFTER .. "|" .. RELEASED
  `)
  const [t, val, after, released] = env.get('OUT').split('|')
  assert.equal(t, 'number',
    `hold_control 必须写数字，实际 ${t}（写布尔会让引擎抛 arithmetic on a boolean）`)
  assert.equal(val, '0', '引擎自己的约定：0 表示按住')
  assert.equal(after, '0', '过一遍引擎倒计时后仍应是 0（说明算术没抛错）')
  assert.equal(released, 'nil', '松开必须是 nil（和 OnRemoteStopControl 一致）')
})

test('CHOP-13（INTEGRATION）：忙的时候**不许重推**（重推会 Clear 掉走路/挥砍）', async () => {
  // 真机 bug（2026-11-17）：那段"每 0.4 秒兜底重推"原来是**无条件**的，
  // 而 `loco:PushAction` 第一件事是 `self:Clear()` —— 每 0.4 秒就把正在走的寻路、
  // 正在演的挥砍取消一次，人杵在原地、砍得极慢（实测一棵桦栗树砍了 14 秒）。
  //
  // 唯一正确的门是 `not busy(p)`：走路时 sg 带 `moving` 标签且 `GetBufferedAction()` 非 nil，
  // busy 就是 true，所以"走路中不重推"已经由它保证。
  // （曾经额外加过 `tiles <= 2.0` 的距离门，但 start 允许到 2.5 格 →
  //   2.0~2.5 格成死区，推一次后没人驱动。真机实测踩到。）
  const env = await loadTargets({ preload: `
    PUSHES = 0
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      PUSHES = PUSHES + 1
      return real_pa(self, ba, run)
    end
  ` })
  env.run(`
    TREE = (function()
      local e = mkent({ prefab = "evergreen", guid = 601, x = 4, z = 0, work = "CHOP" })
      local w = { action = { id = "CHOP" }, workleft = 99 }
      e.components.workable = w
      return e
    end)()
    WORLD = { TREE }
    ${axeLua}
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-busy", { target = TREE })
    Whale.actions.Tick()          -- start：这一次 push 是合法的首次下发
    -- ① 模拟"正在走路/正在演动画"：有 buffered_action → busy = true
    PLAYER.buffered_action = { action = { id = "WALKTO" } }
    local before = PUSHES
    for i = 1, 6 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    BUSY_PUSHES = PUSHES - before
    HELD_WHILE_BUSY = tostring(PLAYER.components.playercontroller.remote_controls[GLOBAL.CONTROL_ACTION] ~= nil)
  `)
  assert.equal(env.get('BUSY_PUSHES'), '0',
    '忙的时候（走路/挥砍中）绝对不该重推 —— 每推一次都会 Clear 掉当前动作')
  assert.equal(env.get('HELD_WHILE_BUSY'), 'false', '忙的时候也不该去开"按住动作键"')

  // ② 手空下来（这一下演完了）→ 这时才允许重推 + 打开按住
  env.run(`
    PLAYER.buffered_action = nil
    local before = PUSHES
    for i = 1, 6 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    IDLE_PUSHES = PUSHES - before
    HELD_IDLE = tostring(PLAYER.components.playercontroller.remote_controls[GLOBAL.CONTROL_ACTION] ~= nil)
  `)
  assert.ok(Number(env.get('IDLE_PUSHES')) >= 1, '手空下来后应该继续重推（连砍兜底）')
  assert.equal(env.get('HELD_IDLE'), 'true', '手空下来后才打开"按住动作键"，让引擎自己连砍')
})

test('CHOP-14（INTEGRATION）：起手阶段（引擎还没跑起来）**不许重推** —— 这就是"停几秒"的根因', async () => {
  // 用户实测原话："走到第一颗树前停了几秒，砍一下后会顿一下，后边呢是连砍"。
  // 从我们 `push` 到引擎真的把动作跑起来之间，`busy(p)` 仍然是 false，
  // 若无条件重推，就会每 0.4 秒用 `loco:PushAction` 里的 `self:Clear()`
  // 把刚排上队的动作取消重排 → 起手停滞。所以必须"见过引擎忙"之后才允许重推。
  const env = await loadTargets({ preload: hitPreload('TREE', 'PUSHES') })
  env.run(`
    TREE = (function()
      local e = mkent({ prefab = "evergreen", guid = 601, x = 4, z = 0, work = "CHOP" })
      e.components.workable = { action = { id = "CHOP" }, workleft = 99 }
      return e
    end)()
    WORLD = { TREE }
    ${axeLua}
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-fresh", { target = TREE })
    Whale.actions.Tick()               -- start：这一次 push 是合法的首次下发
    local before = PUSHES
    -- 引擎还没跑起来（busy 一直 false），时间只走 1.8 秒，小于 2.5 秒兜底宽限
    for i = 1, 3 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    GRACE_PUSHES = PUSHES - before
    HELD_IN_GRACE = tostring(PLAYER.components.playercontroller.remote_controls[GLOBAL.CONTROL_ACTION] ~= nil)
  `)
  assert.equal(env.get('GRACE_PUSHES'), '0',
    '起手阶段不该重推（每推一次都会把排队中的动作取消重排 → 就是那个"停几秒"）')
  assert.equal(env.get('HELD_IN_GRACE'), 'false', '起手阶段也不该打开"按住动作键"')

  // 但宽限不能变成死锁：超过 2.5 秒还起不来，要能自己救一次
  env.run(`
    local before = PUSHES
    for i = 1, 4 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    AFTER_GRACE_PUSHES = PUSHES - before
  `)
  assert.ok(Number(env.get('AFTER_GRACE_PUSHES')) >= 1,
    '超过宽限还起不来时应该兜底重推一次（否则第一次 push 被静默丢掉就永远不动了）')
})

test('CHOP-5（INTEGRATION）：挖矿走同一条链，连挖到碎（不能挖一下就停）', async () => {
  const env = await loadTargets({ preload: hitPreload('ROCK', 'PUSHES') })
  env.run(`
    ROCK = (function()
      local e = mkent({ prefab = "rock1", guid = 611, x = 2, z = 0, work = "MINE" })
      local left = 3
      local action = { id = "MINE" }
      local w = {}
      function w.hit() left = left - 1; if left <= 0 then action = nil end end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    WORLD = { ROCK }
    PICK = mkent({ prefab = "pickaxe", guid = 701, x = 0, z = 0, pickup = true })
    PICK.components.finiteuses = { GetUses = function() return 100 end }
    PICK.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "MINE" end }
    ITEMS = { PICK }
    PLAYER.components.inventory.GetEquippedItem = function() return PICK end
    PLAYER.components.inventory.Equip = function() end
    PLAYER.components.playercontroller = { remote_controls = {} }
    
  `)
  env.buildNearby()
  env.run(`
    Whale.actions.Start("mine", { target_kind = "ordinary_rock" }, "c-mine", { target = ROCK })
    for i = 1, 40 do
      NOW = NOW + 0.6
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(PUSHES) .. "|" .. tostring(ROCK.components.workable.workleft)
  `)
  const [pushesRaw, leftRaw] = env.get('OUT').split('|')
  assert.ok(Number(pushesRaw) >= 3, `石头要挖 3 下，实际只 push 了 ${pushesRaw} 次`)
  assert.equal(leftRaw, '0', '挖完之后 workleft 归零')
  const rep = env.report()
  assert.match(String(rep.text), /挖了|石头|rocks/, `应该报挖开，实际 ${rep.text}`)
})
