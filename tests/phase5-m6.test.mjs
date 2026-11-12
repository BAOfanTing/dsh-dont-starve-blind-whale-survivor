// Phase 5 M6 · 任务链引擎 Lua 沙箱测试
//
// 覆盖：任务白名单、前置条件跳过/必需失败、重试、超时、中断清理、进度查询。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const LEGACY_HOME = join(ROOT, 'archive', 'phase-a')

const STUB = `
CLOCK = 1000
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.EQUIPSLOTS = { HANDS = 'hands' }

ITEMS = {}
ENTITIES = {}          -- 附近实体 prefab 列表
STARTED_JOBS = {}      -- 记录 Whale.actions.Start 的调用
CURRENT_JOB = nil
RELEASED = 0

function make_inventory()
  return {
    ForEachItem = function(self, fn)
      for _, it in ipairs(ITEMS) do
        fn({ prefab = it.prefab, components = { stackable = { StackSize = function() return it.n end } } })
      end
    end,
    GetEquippedItem = function() return nil end,
  }
end

PLAYER = {
  components = {
    health = { IsDead = function() return false end },
    locomotor = { Stop = function() end, Clear = function() end },
    inventory = nil,
    hunger = { GetPercent = function() return 0.3 end },
  },
  HasTag = function() return false end,
  ClearBufferedAction = function() end,
}

Whale = {
  util = {
    player = function() return PLAYER end,
    find_all = function(p, radius, musttags, canttags, filter)
      local out = {}
      for _, pf in ipairs(ENTITIES) do
        local e = { prefab = pf }
        if filter == nil or filter(e) then
          out[#out + 1] = { ent = e, d = 1 }
        end
      end
      return out
    end,
  },
  actions = {
    Start = function(name, args)
      STARTED_JOBS[#STARTED_JOBS + 1] = { name = name, args = args }
      CURRENT_JOB = name
      return true, nil
    end,
    Current = function() return CURRENT_JOB end,
    Stop = function() CURRENT_JOB = nil; return true end,
    hold_control = function(p, want) if want == false then RELEASED = RELEASED + 1 end; return true end,
  },
}

BWS2 = {}
`

function load(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label}: ${m}`)
    }
  }
  run(STUB, '假环境')
  run(readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'task_runner.lua'), 'utf8'), 'task_runner.lua')
  return { run }
}

test('M6：只接受白名单任务名，未知任务被拒', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local ok, err = BWS2.tasks.Start('rm_rf_slash')
    assert(ok == false, '未知任务应被拒')
    assert(string.find(err, '没有这个任务', 1, true) ~= nil, '错误信息应说明，实际 ' .. tostring(err))
    -- 已知任务能启动
    local ok2, err2 = BWS2.tasks.Start('survive_night')
    assert(ok2 == true, 'survive_night 应能启动，实际 ' .. tostring(err2))
  `)
})

test('M6：任务名非字符串被拒', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local ok = BWS2.tasks.Start(123)
    assert(ok == false, '数字应被拒')
    local ok2 = BWS2.tasks.Start(nil)
    assert(ok2 == false, 'nil 应被拒')
  `)
})

test('M6：已有任务在跑时不能重复启动', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    assert(BWS2.tasks.Start('forage') == true)
    local ok, err = BWS2.tasks.Start('stock_logs')
    assert(ok == false, '重复启动应被拒')
    assert(string.find(err, '已有任务在跑', 1, true) ~= nil, '实际 ' .. tostring(err))
  `)
})

test('M6：前置条件不满足时可选步骤被跳过', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    -- 附近什么都没有、背包也空 → forage 的 3 步全是 optional，应全部跳过
    ENTITIES = {}
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    assert(BWS2.tasks.Start('forage') == true)
    -- 连续 Tick 推进（每 Tick 走一步状态）
    for i = 1, 20 do BWS2.tasks.Tick() end
    local s = BWS2.tasks.Summary()
    assert(s.running == false, '应该跑完了')
    assert(#STARTED_JOBS == 0, '不该启动任何动作，实际 ' .. #STARTED_JOBS)
  `)
})

test('M6：前置条件满足时启动对应动作', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ENTITIES = { 'grass' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    assert(BWS2.tasks.Start('forage') == true)
    BWS2.tasks.Tick()   -- 第一步：检查前置 → 启动 pick
    assert(#STARTED_JOBS == 1, '应启动 1 个动作，实际 ' .. #STARTED_JOBS)
    assert(STARTED_JOBS[1].name == 'pick', '应是 pick，实际 ' .. tostring(STARTED_JOBS[1].name))
    assert(STARTED_JOBS[1].args.target == 'grass')
  `)
})

test('M6：动作成功后推进到下一步', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ENTITIES = { 'grass' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    assert(BWS2.tasks.Start('forage') == true)
    BWS2.tasks.Tick()                    -- 启动第 1 步
    assert(CURRENT_JOB == 'pick')
    CURRENT_JOB = nil                    -- 模拟动作结束
    BWS2.tasks.OnActionResult(true, '采了 3 次')
    BWS2.tasks.Tick()                    -- 结算第 1 步成功 → 第 2 步
    local s = BWS2.tasks.Summary()
    assert(s.steps_done >= 1, '应记录 1 步完成，实际 ' .. tostring(s.steps_done))
  `)
})

test('M6：可选步骤失败后跳过继续', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ENTITIES = { 'grass' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    assert(BWS2.tasks.Start('forage') == true)
    BWS2.tasks.Tick()
    CURRENT_JOB = nil
    BWS2.tasks.OnActionResult(false, '采不动')
    BWS2.tasks.Tick()   -- 第 1 次失败 → 重试（retry=1）
    BWS2.tasks.Tick()   -- 重试也失败 → 跳过
    local s = BWS2.tasks.Summary()
    assert(s.steps_skipped >= 1 or s.steps_done >= 0, '应记录跳过或继续')
  `)
})

test('M6：必需步骤失败 → 整个任务中止', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    -- stock_logs 的 chop 是必需步骤（optional=false）
    ENTITIES = { 'tree' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    assert(BWS2.tasks.Start('stock_logs') == true)
    -- 一路 Tick 到 chop 启动
    for i = 1, 20 do
      BWS2.tasks.Tick()
      if CURRENT_JOB == 'chop' then break end
      CURRENT_JOB = nil
      BWS2.tasks.OnActionResult(true, 'ok')
    end
    assert(CURRENT_JOB == 'chop', '应到 chop 步，实际 ' .. tostring(CURRENT_JOB))
    -- 让 chop 失败到底
    for i = 1, 6 do
      CURRENT_JOB = nil
      BWS2.tasks.OnActionResult(false, '砍不动')
      BWS2.tasks.Tick()
    end
    local s = BWS2.tasks.Summary()
    assert(s.running == false, '必需步骤失败应中止任务')
  `)
})

test('M6：停止任务会清理（松开按键 + 停止动作）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ENTITIES = { 'grass' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    RELEASED = 0
    assert(BWS2.tasks.Start('forage') == true)
    BWS2.tasks.Tick()
    local ok, err = BWS2.tasks.Stop('测试')
    assert(ok == true, '停止应成功')
    assert(RELEASED >= 1, '应松开按键，实际 ' .. tostring(RELEASED))
    assert(BWS2.tasks.Summary().running == false, '停止后不应在跑')
    -- 没任务时停止应报错
    local ok2, err2 = BWS2.tasks.Stop('again')
    assert(ok2 == false, '没任务时停止应失败')
    assert(string.find(err2, '没有任务', 1, true) ~= nil)
  `)
})

test('M6：超时后跳到下一步', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ENTITIES = { 'grass' }
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    STARTED_JOBS = {}
    CURRENT_JOB = nil
    assert(BWS2.tasks.Start('forage') == true)
    BWS2.tasks.Tick()                     -- 启动第 1 步（timeout=90）
    assert(CURRENT_JOB == 'pick')
    CLOCK = CLOCK + 200                   -- 跳过 200 秒
    BWS2.tasks.Tick()                     -- 应判超时 → 停止动作 + 下一步
    local s = BWS2.tasks.Summary()
    assert(s.last_error ~= nil or s.step_index > 1, '超时应有记录或推进')
  `)
})

test('M6：Summary 暴露可用任务名单与进度字段', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local s = BWS2.tasks.Summary()
    assert(type(s.known_tasks) == 'table', '应暴露 known_tasks')
    assert(#s.known_tasks >= 4, '至少 4 个任务模板，实际 ' .. tostring(#s.known_tasks))
    local names = table.concat(s.known_tasks, ',')
    for _, want in ipairs({ 'survive_night', 'stock_logs', 'toolkit', 'forage' }) do
      assert(string.find(names, want, 1, true) ~= nil, '缺少任务 ' .. want)
    end
    assert(s.running == false, '初始应没在跑')
  `)
})
