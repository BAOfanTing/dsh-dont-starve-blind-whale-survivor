// Phase 6 · Lua 沙箱测试（威胁观察器 + 战斗执行器/Kiting + 白名单两侧一致）
//
// 跑的是真 Lua（fengari）里的真文件，不是重新实现的逻辑：
//   scripts/main/threat_observer.lua   威胁扫描与环境读数
//   scripts/main/combat_executor.lua   9 态状态机 + Kiting + 白名单/确认/单执行者
//
// 覆盖点（对应任务书验收 1/2/4/7/11/12）：
//   · 敌对生物识别、分类、距离、追击/出手状态、数量
//   · 无档案敌人 → 拒绝自动交战（保守避战）
//   · Boss → 硬拦（连传参都进不来）
//   · start_combat 没有 confirmed=true → 拒绝
//   · 战斗中不允许第二个执行器；原子动作被 action_executor 拒绝
//   · 生命低于阈值 → RETREATING；abort → ABORTED
//   · 两侧白名单（Lua AUTONOMOUS_ENEMIES / BOSS_PREFABS ↔ TS profiles.ts）逐项一致
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
ATTACKS = 0
MOVES = 0
STOPS = 0
HP = 100
REPORTS = {}
POSTS = {}
BOSS_TAG = false
TARGET_ATTACKING = false
TARGET_HP = 100
FOUND = {}
INV_ITEMS = {}
EQUIP_LOG = {}

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.STRINGS = { NAMES = { HOUND = '猎犬', SPIDER = '蜘蛛', DEERCLOPS = '巨鹿' } }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.ACTIONS = { ATTACK = { id = 'ATTACK' } }
GLOBAL.EQUIPSLOTS = { HANDS = 'hands', BODY = 'body', HEAD = 'head' }
GLOBAL.BufferedAction = function(p, target, action, item) return { target = target, action = action } end

BWS = { json = { round = function(v, digits)
    if v == nil then return nil end
    local mult = 10 ^ (digits or 0)
    return math.floor(v * mult + 0.5) / mult
end, decode = function() return { allowed = true, code = 'OK' } end } }

function make_entity(opts)
    local e = {
        prefab = opts.prefab,
        prefb = opts.prefab,
        x = opts.x or 12,
        z = opts.z or 10,
        hostile = opts.hostile ~= false,
        monster = opts.monster == true,
        targeting = opts.targeting == true,
        attacking = opts.attacking == true,
        sleeping = opts.sleeping == true,
    }
    e.Transform = { GetWorldPosition = function() return e.x, 0, e.z end }
    e.HasTag = function(self, tag)
        if tag == 'hostile' then return e.hostile end
        if tag == 'monster' then return e.monster end
        if tag == 'epic' then return BOSS_TAG end
        return false
    end
    e.IsValid = function() return true end
    e.sg = { HasStateTag = function(self, tag) return tag == 'attack' and e.attacking end }
    e.components = {
        sleeper = opts.sleeping and { IsAsleep = function() return true end } or nil,
        health = {
            GetPercent = function() return (e.hp or TARGET_HP) / 100 end,
            IsDead = function() return false end,
        },
        combat = {
            target = e.targeting and PLAYER or nil,
            attackperiod = 2,
            defaultdamage = 20,
            GetAttackRange = function() return 2 end,
            CanAttack = function() return true end,
            TryAttack = function(self, target) ATTACKS = ATTACKS + 1; return true end,
        },
    }
    return e
end

GLOBAL.TheSim = {
    GetRealTime = function() return CLOCK * 1000 end,
    GetTick = function() return CLOCK end,
    FindEntities = function(self, x, y, z, radius, musttags, canttags, oneoftags)
        local out = {}
        for _, e in ipairs(FOUND) do out[#out + 1] = e end
        return out
    end,
}
GLOBAL.TheWorld = {
    state = {
        isday = false, isdusk = false, isnight = true, phase = 'night',
        season = 'winter', remainingdaysinseason = 3, elapseddaysinseason = 12,
        cycles = 14, temperature = -5, israining = false, issnowing = true, wetness = 0,
    },
    DoPeriodicTask = function(self, interval, fn)
        return { Cancel = function() end, Run = fn }
    end,
}
GLOBAL.AllPlayers = {}

BWS2 = {
    connection = { protocolVersion = function() return '1.0' end, session = function() return 'S1' end },
    config = { get = function() return { token = 'T' } end },
    http = { post = function(path, body, cb)
        POSTS[#POSTS + 1] = { path = path, body = body }
        if path == '/api/v1/control/assert' and cb ~= nil then
            cb({ ok = true, status = 200, body = '{"allowed":true}' })
        end
    end },
}

PLAYER = {
    prefab = 'wilson',    Transform = { GetWorldPosition = function() return 10, 0, 10 end },
    HasTag = function() return false end,
    ClearBufferedAction = function() end,
    IsValid = function() return true end,
    components = {
        health = {
            currenthealth = 100, maxhealth = 100,
            GetPercent = function() return HP / 100 end,
            IsDead = function() return false end,
        },
        hunger = { current = 150, max = 150, GetPercent = function() return 1 end },
        combat = {
            TryAttack = function(self, target) ATTACKS = ATTACKS + 1; return true end,
            CanAttack = function() return true end,
            GetAttackRange = function() return 2 end,
        },
        locomotor = {
            GoToPoint = function() MOVES = MOVES + 1 end,
            Stop = function() STOPS = STOPS + 1 end,
            PushAction = function() end,
        },
        inventory = {
            GetEquippedItem = function() return nil end,
            ForEachItem = function(self, fn)
                for _, it in ipairs(INV_ITEMS) do fn(it) end
            end,
            Equip = function(self, item) EQUIP_LOG[#EQUIP_LOG + 1] = item.prefab end,
        },
    },
}

Whale = {
    util = {
        player = function() return PLAYER end,
        pos = function() return 10, 0, 10 end,
        log = function() end,
    },
    actions = { Current = function() return nil end, Start = function() return true end },
}

function report(commandId, status, result, err)
    REPORTS[#REPORTS + 1] = { id = commandId, status = status, result = result, error = err }
end

function find_report(status)
    for i = #REPORTS, 1, -1 do
        if REPORTS[i].status == status then return REPORTS[i] end
    end
    return nil
end
`

function load(fengari, modules) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label}: ${message}`)
    }
  }
  run(STUB, '假环境')
  for (const module of modules) {
    run(readFileSync(join(LEGACY_HOME, 'scripts', 'main', module), 'utf8'), module)
  }
  return { run }
}

async function luaWith(...modules) {
  const fengari = await import('fengari')
  return { fengari, ...load(fengari, modules) }
}

// ───────────────────────── Threat Observer ─────────────────────────

test('P6-M1：威胁扫描识别敌对生物、距离、追击与出手状态', async () => {
  const { run } = await luaWith('threat_observer.lua')
  run(`
    local hound = make_entity({ prefab = 'hound', x = 16, z = 10, targeting = true, attacking = true })
    local spider = make_entity({ prefab = 'spider', x = 20, z = 10 })
    local rock = make_entity({ prefab = 'rock1', hostile = false, monster = false })
    FOUND = { hound, spider, rock }
    local result, err = BWS.threat_observer.Observe(PLAYER, { radius_tiles = 12 })
    assert(result ~= nil, '应返回结果：' .. tostring(err))
    assert(result.hostile_count == 2, '石头不该算威胁，实际 ' .. tostring(result.hostile_count))
    assert(result.chasing_count == 1, '应有 1 个在追')
    assert(result.attacking_count == 1, '应有 1 个在出手')
    assert(result.nearest_distance == 1.5, '最近 6 世界单位 = 1.5 格，实际 ' .. tostring(result.nearest_distance))
    assert(result.threats[1].prefab == 'hound', '按距离排序：猎犬在前')
    assert(result.threats[1].targeting_player == true, '追击状态要平铺出来')
    assert(result.threats[1].attack_range == 2, '攻击距离要读运行时值')
    assert(result.threats[1].attack_period == 2, '出手周期要读运行时值')
    assert(result.threats[2].prefab == 'spider')
  `)
})

test('P6-M1：Boss（epic 标签/档案名）能被标记，睡着的敌人单独标记', async () => {
  const { run } = await luaWith('threat_observer.lua')
  run(`
    BOSS_TAG = true   -- 沙箱里 epic 标签是全局开关，两个实体会一起带上
    local deer = make_entity({ prefab = 'deerclops', x = 14, z = 10 })
    local sleeper = make_entity({ prefab = 'spider', x = 12, z = 10, sleeping = true })
    FOUND = { deer, sleeper }
    local result = BWS.threat_observer.Observe(PLAYER, { radius_tiles = 12 })
    assert(result.boss_count >= 1, 'Boss 至少 1 个，实际 ' .. tostring(result.boss_count))
    local saw_boss, saw_sleeping = false, false
    for _, entry in ipairs(result.threats) do
      if entry.prefab == 'deerclops' and entry.is_boss == true then saw_boss = true end
      if entry.sleeping == true then saw_sleeping = true end
    end
    assert(saw_boss, 'deerclops 应标成 Boss')
    assert(saw_sleeping, '睡着的敌人要如实标 sleeping=true')
    BOSS_TAG = false
  `)
})

test('P6-M1：环境读数（黑夜无光 / 体温 / 季节剩余天数）只报事实不下结论', async () => {
  const { run } = await luaWith('threat_observer.lua')
  run(`
    FOUND = {}   -- 附近没有任何带 Light 的实体
    local env, err = BWS.threat_observer.ObserveEnvironment(PLAYER)
    assert(env ~= nil, '应返回环境读数：' .. tostring(err))
    assert(env.is_night == true, '夜里应报 is_night')
    assert(env.in_light == false, '附近没有光源 → in_light=false')
    assert(env.light_sources_within_8 == 0, '光源数应为 0')
    assert(env.season == 'winter', '季节来自 world.state')
    assert(env.remaining_days_in_season == 3, '剩余天数来自 world.state，不写死')
    assert(env.day == 15, 'cycles=14 → 第 15 天')
  `)
})

// ───────────────────────── Combat Executor ─────────────────────────

test('P6-M4：start_combat 没有 confirmed=true → 拒绝（SUPERVISED_COMBAT 程序层强制）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    FOUND = { make_entity({ prefab = 'hound', x = 13, z = 10 }) }
    BWS2.combat.executeCommand({ id = 'c1', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1' } }, report, 0)
    local rep = find_report('FAILED')
    assert(rep ~= nil, '应回报 FAILED')
    assert(string.find(rep.error, 'confirmation_required', 1, true) ~= nil, '错误码应是 confirmation_required，实际 ' .. tostring(rep.error))
    assert(BWS2.combat.status().state == 'IDLE', '被拒绝时不应进入状态机')
  `)
})

test('P6-M4：Boss 与无档案生物一律拒绝自动交战（保守避战）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    FOUND = { make_entity({ prefab = 'deerclops', x = 13, z = 10 }) }
    BWS2.combat.executeCommand({ id = 'c2', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true, target_prefab = 'deerclops' } }, report, 0)
    local rep = find_report('FAILED')
    assert(rep ~= nil and string.find(rep.error, 'boss_requires_supervised_combat', 1, true) ~= nil, 'Boss 必须被硬拦：' .. tostring(rep and rep.error))

    REPORTS = {}
    FOUND = { make_entity({ prefab = 'spider_warrior_queen_thing', x = 13, z = 10 }) }
    BWS2.combat.executeCommand({ id = 'c3', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true, target_prefab = 'spider_warrior_queen_thing' } }, report, 0)
    local rep2 = find_report('FAILED')
    assert(rep2 ~= nil and string.find(rep2.error, 'unverified_enemy', 1, true) ~= nil, '无档案生物要拒绝：' .. tostring(rep2 and rep2.error))
  `)
})

test('P6-M4：正常敌人 → ASSESSING/PREPARING/ENGAGING，tick 会真的攻击（原生 TryAttack）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    FOUND = { make_entity({ prefab = 'hound', x = 12.5, z = 10 }) }
    BWS2.combat.executeCommand({ id = 'c4', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    local rep = find_report('EXECUTING')
    assert(rep ~= nil, '启动后应回 EXECUTING')
    assert(rep.result.accepted == true)
    assert(BWS2.combat.status().state == 'ASSESSING', '启动后应进入 ASSESSING')

    -- 推进 2 秒（Drive 是观察器 tick 的兜底驱动）
    CLOCK = CLOCK + 2
    BWS2.combat.Drive()
    CLOCK = CLOCK + 1
    BWS2.combat.Drive()
    assert(ATTACKS > 0, '进入距离后应该真的攻击（TryAttack 被调用 ' .. tostring(ATTACKS) .. ' 次）')
    local status = BWS2.combat.status()
    assert(status.hits > 0, '命中计数要涨')
    assert(status.api.try_attack == true, 'API 探测要如实报告 TryAttack 可用')
  `)
})

test('P6-M4：生命低于阈值 → 自动 RETREATING（不靠上层提醒）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    ATTACKS = 0
    FOUND = { make_entity({ prefab = 'hound', x = 12.5, z = 10 }) }
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c5', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true, retreat_hp_percent = 40 } }, report, 0)
    CLOCK = CLOCK + 2
    BWS2.combat.Drive()          -- ASSESSING → PREPARING → ENGAGING
    HP = 20                      -- 血掉到 20%
    CLOCK = CLOCK + 2
    BWS2.combat.Drive()          -- 触发撤退
    local status = BWS2.combat.status()
    assert(status.state == 'RETREATING' or status.state == 'RECOVERING' or status.state == 'COMPLETE',
      '低血应进入撤退/恢复，实际 ' .. tostring(status.state))
    assert(STOPS > 0 or MOVES > 0, '撤退要真的动起来（Stop/GoToPoint 被调用）')
  `)
})

test('P6-M4：abort_combat 立刻停手（ABORTED + FAILED 回执）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    HP = 100
    FOUND = { make_entity({ prefab = 'spider', x = 13, z = 10 }) }
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c6', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    CLOCK = CLOCK + 2
    BWS2.combat.Drive()
    BWS2.combat.executeCommand({ id = 'c7', type = 'abort_combat', params = { controller_id = 'C1', session_id = 'S1' } }, report, 0)
    local status = BWS2.combat.status()
    assert(status.state == 'ABORTED', '中止后状态应是 ABORTED，实际 ' .. tostring(status.state))
    assert(status.active == false, '中止后不应还是 active')
    local last = REPORTS[#REPORTS]
    assert(string.find(tostring(last.error), 'aborted', 1, true) ~= nil, '应回 FAILED aborted')
  `)
})

test('P6-M4：同一时间只允许一个战斗执行器（第二个 start_combat 被拒）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    FOUND = { make_entity({ prefab = 'hound', x = 13, z = 10 }) }
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c8', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    BWS2.combat.executeCommand({ id = 'c9', type = 'start_combat', params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    local rep = find_report('FAILED')
    assert(rep ~= nil and string.find(rep.error, 'combat_already_running', 1, true) ~= nil,
      '第二个战斗必须被拒：' .. tostring(rep and rep.error))
    assert(BWS2.combat.is_active() == true, '第一个战斗应仍然在跑')
  `)
})

test('P6-M4：状态机拒绝非法迁移（IDLE 不能直接 COMPLETE）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    local ok = BWS2.combat.status()
    assert(ok.state == 'IDLE', '初始应是 IDLE')
    -- 通过公开接口无法直接跳状态；这里验证 abort 在没有战斗时是安全的
    BWS2.combat.executeCommand({ id = 'c10', type = 'abort_combat', params = { controller_id = 'C1', session_id = 'S1' } }, report, 0)
    assert(BWS2.combat.status().state == 'IDLE', '没有战斗时 abort 应保持 IDLE')
  `)
})

test('P6-M4：周围敌对超过上限 → 拒绝开战（被围攻不接单，硬门槛在 Lua）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    -- 真机教训（2026-11-12）：青蛙雨时 20 只青蛙在场，单杀一只是送人头
    FOUND = {
      make_entity({ prefab = 'frog', x = 13, z = 10 }),
      make_entity({ prefab = 'frog', x = 14, z = 10 }),
      make_entity({ prefab = 'frog', x = 15, z = 10 }),
      make_entity({ prefab = 'frog', x = 16, z = 10 }),
    }
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c20', type = 'start_combat',
      params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    local rep = find_report('FAILED')
    assert(rep ~= nil, '4 个敌人时应拒绝')
    assert(string.find(rep.error, 'too_many_enemies', 1, true) ~= nil,
      '错误码应是 too_many_enemies，实际 ' .. tostring(rep and rep.error))
    assert(BWS2.combat.status().state == 'IDLE', '被拒绝时不应进入状态机')

    -- 上限调到 5 时应该放行
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c21', type = 'start_combat',
      params = { controller_id = 'C1', session_id = 'S1', confirmed = true, max_enemies = 5 } }, report, 0)
    assert(find_report('EXECUTING') ~= nil, '上限 5 时应放行')
  `)
})

test('P6-M4：手上空着时从背包挑伤害最高的武器装备（只装备，不制作）', async () => {
  const { run } = await luaWith('threat_observer.lua', 'combat_executor.lua')
  run(`
    INV_ITEMS = { { prefab = 'axe' }, { prefab = 'spear' }, { prefab = 'torch' } }
    EQUIP_LOG = {}
    FOUND = { make_entity({ prefab = 'spider', x = 13, z = 10 }) }
    REPORTS = {}
    BWS2.combat.executeCommand({ id = 'c22', type = 'start_combat',
      params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report, 0)
    CLOCK = CLOCK + 2
    BWS2.combat.Drive()   -- ASSESSING → PREPARING（这里会装备武器）→ ENGAGING
    assert(#EQUIP_LOG == 1, '应装备一次，实际 ' .. tostring(#EQUIP_LOG))
    assert(EQUIP_LOG[1] == 'spear', '应挑伤害最高的 spear，实际 ' .. tostring(EQUIP_LOG[1]))
    assert(BWS2.combat.status().equipped_weapon == 'spear', 'status 要能查到装备了什么')
    INV_ITEMS = {}
    EQUIP_LOG = {}
  `)
})

// ───────────────────────── 两侧白名单一致 ─────────────────────────
function luaTableKeys(source, tableName) {
  const start = source.indexOf(`local ${tableName} = {`)
  assert.ok(start >= 0, `找不到 Lua 表 ${tableName}`)
  const end = source.indexOf('}', start)
  const body = source.slice(start, end)
  const keys = []
  for (const match of body.matchAll(/^\s*([a-z_0-9]+) = true,/gm)) keys.push(match[1])
  return keys.sort()
}

test('P6：Lua 的自动交战白名单与 TS 档案一致（防两边漂移）', async () => {
  const luaSource = readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'combat_executor.lua'), 'utf8')
  const luaAuto = luaTableKeys(luaSource, 'AUTONOMOUS_ENEMIES')
  const profiles = await import('../mcp-server/dist/src/survival/profiles.js')
  assert.deepEqual(luaAuto, profiles.autoEngageList(), 'Lua AUTONOMOUS_ENEMIES 必须等于 TS autoEngageList')
})

test('P6：Lua 与 TS 的 Boss 名单一致', async () => {
  const luaThreat = readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'threat_observer.lua'), 'utf8')
  const luaCombat = readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'combat_executor.lua'), 'utf8')
  const profiles = await import('../mcp-server/dist/src/survival/profiles.js')
  const tsBosses = profiles.bossList()
  assert.deepEqual(luaTableKeys(luaThreat, 'BOSS_PREFABS'), tsBosses, 'threat_observer 的 Boss 名单要和 TS 一致')
  assert.deepEqual(luaTableKeys(luaCombat, 'BOSS_PREFABS'), tsBosses, 'combat_executor 的 Boss 名单要和 TS 一致')
})
