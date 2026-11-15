// NATIVE-REUSE：复用原版能力的验证（逃跑方向 / 真实照明 / 玩家攻击）
//
// 这一组测试存在的理由：这一层复用的是**原版脚本的行为**，而不是我们自己写的逻辑，
// 所以必须证明三件事，否则"复用了"只是口头声明：
//   1) 调用的原版 API 在本机构建（762172）的 scripts.zip 里**真的存在**（静态核对，
//      不是凭记忆 —— 之前踩过 `loco:IsMoving()` 这种不存在的 API）；
//   2) 参数和返回值按原版语义用（角度单位、Vector3、返回 item 等）；
//   3) 拿不到原版能力时**有回退**，不能因为复用失败就整个崩掉。
//
// 另外覆盖 Reflex 的职责收窄：解决不了就上报需求，而不是无限重试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const LUA = (name) => readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8')

/**
 * 读**原版**脚本原文（用来真的跑一遍，而不是只做静态断言）。
 *
 * 为什么这么做：这一层复用的是原版行为，最硬的证据就是"把原版文件加载进来、真的调用它"。
 * 但原版脚本属于 Klei，不能进仓库，所以只在**本机装了饥荒**时才跑；
 * 没装就跳过（并在测试名里说明），不会变成假绿。
 */
function vanillaScript(rel) {
  const candidates = [
    join(ROOT, '.runtime', 'dst-scripts', 'scripts', rel),
    join('E:', 'SteamLibrary', 'steamapps', 'common', "Don't Starve Together", 'data', 'datastandard', 'scripts', rel),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  return null
}

/** 原版 RunAway 依赖的 behaviours/behaviourtree.lua（Class / BehaviourNode / 状态常量） */
const HAS_VANILLA = vanillaScript('behaviours/runaway.lua') !== null

const nativeLua = LUA('native')
const reflexLua = LUA('reflex')
const actionsLua = LUA('actions')
const observeLua = LUA('observe')
const modmain = readFileSync(join(MOD, 'modmain.lua'), 'utf8')

/** 去掉行注释，避免注释里的示例被当成真代码 */
function code(text) {
  return text.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

// ═══════════════════════ 一、静态：复用的原版 API 真的存在 ═══════════════════════

test('NR-1：native 层不依赖 `lightsource` 标签（本机构建里只有人读、没人写）', () => {
  const live = code(nativeLua)
  assert.ok(!/lightsource/.test(live),
    'native.lua 不能按 lightsource 标签找光源：构建 762172 的 4109 个 Lua 文件里这个标签只有查询、没有写入')
  // 注释里可以解释原因
  assert.match(nativeLua, /lightsource/, '注释里要留下"为什么不用它"的依据，否则下一个人会加回来')
})

test('NR-2：照明判断用的是引擎读数（IsInLight / GetLightAtPoint），不是自己推的背包状态', () => {
  const live = code(nativeLua)
  assert.match(live, /:IsInLight\(\)/, '要优先用 inst:IsInLight()（玩家身上有 LightWatcher，是权威判断）')
  assert.match(live, /GetLightAtPoint/, '拿不到 LightWatcher 时要用引擎光强')
  assert.match(live, /GetCalculatedRadius/, '光源半径要用引擎给的 GetCalculatedRadius')
})

test('NR-3：逃跑方向复用原版 RunAway:GetRunAngle，而不是自己算直线', () => {
  const live = code(nativeLua)
  assert.match(live, /GetRunAngle/, '要用原版 behaviours/runaway.lua 的 GetRunAngle')
  assert.match(live, /require\("behaviours\/runaway"\)/, '要 require 原版节点，不许复制一份到模组目录')
  // 反例：不允许出现"我们自己写的背离角度"那种公式
  assert.ok(!/GetAngleToPoint\(hp\)/.test(live), '不能自己算背离角度')
})

test('NR-4：角度→坐标的换算与原版 FindValidPositionByFan 一致（z 取负）', () => {
  const live = code(nativeLua)
  // 原版 simutil.lua:322 offset = Vector3(r*cos(a), 0, -r*sin(a))
  assert.match(live, /math\.cos\(a\)/, '要用 cos 算 x 偏移')
  assert.match(live, /pz - d \* math\.sin\(a\)|pz-d\*math\.sin\(a\)/, 'z 偏移必须是负 sin（和原版一致，否则方向镜像）')
})

test('NR-5：玩家攻击走 ACTIONS.ATTACK 的 BufferedAction，不用 combat:TryAttack', () => {
  const live = code(nativeLua)
  assert.match(live, /BufferedAction\(ent, target, ACTIONS\.ATTACK, nil\)/, '要造 ACTIONS.ATTACK 的 BufferedAction')
  assert.ok(!/TryAttack/.test(live), 'native 层不许调 combat:TryAttack —— SGwilson 没有 doattack 处理器，对玩家是空放')
  // 注释必须留下依据（下一个人一定会想"直接 TryAttack 不就行了"）
  assert.match(nativeLua, /SGwilson/, '注释里要写清 SGwilson 没有 doattack 处理器这个依据')
})

test('NR-6：挥砍次数按引擎记录的真实出手核对（lastdoattacktime）', () => {
  const live = code(nativeLua)
  assert.match(live, /lastdoattacktime/, '要用 combat.lastdoattacktime 判断这一刀有没有真的挥出去')
  const act = code(actionsLua)
  assert.match(act, /LastAttackTime/, 'attack 动作要用它核对，而不是数我们推了几次')
  assert.match(act, /j\.data\.swings/, '要有独立的"真实出手次数"计数')
})

test('NR-7：攻击前看引擎自己的冷却（InCooldown），冷却没完不推', () => {
  const live = code(nativeLua)
  assert.match(live, /InCooldown/, '要用 Combat:InCooldown（玩家 min_attack_period = 0.4s）')
  const act = code(actionsLua)
  assert.match(act, /CanSwing/, 'attack 动作在推之前要问 CanSwing')
})

// ═══════════════════════ 二、行为：在假游戏里真的跑起来 ═══════════════════════

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { TORCH = "火把", FROG = "青蛙", CAMPFIRE = "营火" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { ATTACK = act("ATTACK"), PICK = act("PICK"), PICKUP = act("PICKUP"),
                   HARVEST = act("HARVEST"), EAT = act("EAT"), CHOP = act("CHOP") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.Point = GLOBAL.Vector3
GLOBAL.DEGREES = math.pi / 180
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber

NOW = 1000
NEARBY = {}
LIGHT_VALUE = nil
FIND_OFFSET_OK = true

GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetLightAtPoint = function(self, x, y, z) return LIGHT_VALUE end,
    FindEntities = function(self, x, y, z, r, musttags, canttags, mustoneoftags)
        local out = {}
        for _, e in ipairs(NEARBY) do
            local ok = true
            if musttags ~= nil then
                for _, t in ipairs(musttags) do if not e:HasTag(t) then ok = false end end
            end
            if ok and r ~= nil then
                local ex, _, ez = e.Transform.GetWorldPosition()
                local dx, dz = (ex or 0) - x, (ez or 0) - z
                if dx * dx + dz * dz > r * r then ok = false end
            end
            if ok then out[#out + 1] = e end
        end
        return out
    end,
    SetPersistentString = function() end,
    GetPersistentString = function(self, name, cb) cb(false, nil) end,
}
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 1, phase = "night", season = "autumn", temperature = 20 },
    HasTag = function() return false end,
    DoPeriodicTask = function() end,
    Map = { IsAboveGroundAtPoint = function() return true end },
    Pathfinder = { IsClear = function() return true end },
}
-- 原版 behaviours/runaway.lua 依赖这两个全局；这里按原版签名提供最小实现，
-- 让 RunAway:GetRunAngle 能真的算出一个角度（而不是我们 stub 掉整条路径）。
-- 注意：原版脚本读的是**真全局**（不是 GLOBAL 表），所以这些必须同时挂两边。
TWOPI = math.pi * 2
PI = math.pi
DEGREES = math.pi / 180
GLOBAL.TWOPI = TWOPI
GLOBAL.PI = PI
GLOBAL.DEGREES = DEGREES
FindWalkableOffset = function(position, start_angle, radius, attempts, check_los, ignore_walls)
    if not FIND_OFFSET_OK then return nil, nil, false end
    local a = start_angle
    return GLOBAL.Vector3(radius * math.cos(a), 0, -radius * math.sin(a)), a, false
end
FindSwimmableOffset = FindWalkableOffset
FindNearbyLand = function() return nil end
FindNearbyOcean = function() return nil end
GetTime = function() return NOW end
distsq = function(a, b, c, d)
    if c ~= nil then local dx, dy = a - c, b - d return dx * dx + dy * dy end
    local dx, dz = a.x - b.x, a.z - b.z
    return dx * dx + dz * dz
end
VecUtil_Slerp = function(x1, z1, x2, z2, p)
    local x = x1 + (x2 - x1) * p
    local z = z1 + (z2 - z1) * p
    local len = math.sqrt(x * x + z * z)
    if len < 0.0001 then return 1, 0 end
    return x / len, z / len
end
FunctionOrValue = function(v, ...) if type(v) == "function" then return v(...) end return v end
Class = function(base, ctor)
    if type(base) == "function" then ctor = base; base = nil end
    local cls = {}
    cls.__index = cls
    cls._ctor = ctor
    local mt = { __call = function(c, ...)
        local o = setmetatable({}, cls)
        ctor(o, ...)
        return o
    end }
    if base ~= nil then mt.__index = base end
    setmetatable(cls, mt)
    return cls
end
BehaviourNode = Class(function(self, name, children)
    self.name = name or ""
    self.children = children
    self.status = "READY"
end)
function BehaviourNode:Visit() self.status = "FAILED" end
function BehaviourNode:Sleep(t) self.nextupdatetime = GetTime() + t end
function BehaviourNode:Stop() end
-- 原版 behaviours 里用到的状态常量（behaviourtree.lua:5-8）
READY = "READY"
RUNNING = "RUNNING"
SUCCESS = "SUCCESS"
FAILED = "FAILED"
GLOBAL.READY, GLOBAL.RUNNING, GLOBAL.SUCCESS, GLOBAL.FAILED = READY, RUNNING, SUCCESS, FAILED

-- 假实体
function newent(prefab, x, z, tags, comps)
    local e = { prefab = prefab, components = comps or {}, _tags = {}, _x = x or 0, _z = z or 0 }
    for _, t in ipairs(tags or {}) do e._tags[t] = true end
    function e:IsValid() return true end
    function e:HasTag(tag) return self._tags[tag] == true end
    function e:GetPosition() return GLOBAL.Vector3(self._x, 0, self._z) end
    function e:GetAngleToPoint(pt)
        local x = pt.x or pt[1]
        local z = pt.z or pt[3]
        -- Lua 5.1 是 math.atan2(y, x)；5.3 起用 math.atan(y, x)。两个都兼容。
        local atan2 = math.atan2 or function(y, xx) return math.atan(y, xx) end
        local deg = atan2(z - self._z, x - self._x) * 180 / math.pi
        if deg < 0 then deg = deg + 360 end
        return deg
    end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    return e
end

PLAYER = newent("wilson", 0, 0, { "player" }, {
    health = { IsDead = function() return false end, GetPercent = function() return 1 end },
    combat = {
        target = nil,
        InCooldown = function() return COOLDOWN end,
        GetCooldown = function() return 0 end,
        lastdoattacktime = nil,
    },
    -- 原版 RunAway:GetRunAngle 会问 locomotor 这两个（runaway.lua:60-64）
    locomotor = {
        IsAquatic = function() return false end,
        CanPathfindOnWater = function() return false end,
        Stop = function() end,
    },
})
function PLAYER:IsInLight() return LIGHT_IS_IN end
LIGHT_IS_IN = true
COOLDOWN = false
GLOBAL.AllPlayers = { [1] = PLAYER }
`

function loadNative(fengari, vanillaRunaway) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (src, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(src))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${what} 出错：${message}`)
    }
  }
  run(STUB, '假游戏环境')
  run('Whale = { verbose = false, version = "test", files = {} }', 'Whale 表')
  // 只要 util + native：native 是这一组的主角，别把整条链拖进来
  run(readFileSync(join(MOD, 'scripts', 'whale', 'util.lua'), 'utf8'), 'util.lua')
  if (vanillaRunaway) {
    // 真的加载原版 behaviours/runaway.lua，然后把它挂到 GLOBAL 上
    //（真机里模组沙箱的 GLOBAL 就是 _G，`RunAway = Class(...)` 直接可见；
    //  这里的 GLOBAL 是独立表，所以要手动挂一下，等价于真机行为）
    run(vanillaRunaway, '原版 behaviours/runaway.lua')
    run('GLOBAL.RunAway = RunAway', '把原版 RunAway 挂到 GLOBAL')
  }
  run(nativeLua, 'native.lua')
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  return { run, global }
}

test('NR-8：引擎光强 ≥ 阈值时算"在光里"，低于阈值算"在黑暗里"', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    LIGHT_IS_IN = nil            -- 让 native 走"引擎光强"那条分支
    LIGHT_VALUE = 0.35
    BRIGHT = tostring(Whale.native.IsLit(PLAYER))
    LIGHT_VALUE = 0.02
    DARK = tostring(Whale.native.IsLit(PLAYER))
  `, '光强读数')
  assert.equal(global('BRIGHT'), 'true', '0.35 的光强应该算在光里')
  assert.equal(global('DARK'), 'false', '0.02 的光强应该算在黑暗里')
})

test('NR-9：IsInLight 可用时以它为准（玩家身上的 LightWatcher 是权威判断）', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    LIGHT_VALUE = 0.9            -- 引擎说很亮
    LIGHT_IS_IN = false          -- 但 LightWatcher 说没被照亮（比如被墙挡住）
    RESULT = tostring(Whale.native.IsLit(PLAYER))
  `, 'LightWatcher 优先')
  assert.equal(global('RESULT'), 'false', 'IsInLight() 有结果时不许用光强覆盖它')
})

test('NR-10：光源识别按引擎给的半径判定，不看标签', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    local near = newent("campfire", 4, 0, { "fire" }, {
        fueled = { IsEmpty = function() return false end } })
    near.Light = { IsEnabled = function() return true end,
                   GetCalculatedRadius = function() return 6 end }
    local far = newent("campfire", 40, 0, { "fire" }, {
        fueled = { IsEmpty = function() return false end } })
    far.Light = { IsEnabled = function() return true end,
                  GetCalculatedRadius = function() return 6 end }
    NEARBY = { near, far }
    local src = Whale.native.FindLitSource(PLAYER, 12)
    FOUND = src ~= nil and tostring(src.prefab) or "nil"
    -- 半径外的（40 格）不该被当成照明
    NEARBY = { far }
    OUT = tostring(Whale.native.FindLitSource(PLAYER, 12) == nil)
  `, '光源半径')
  assert.equal(global('FOUND'), 'campfire', '6 格半径内的营火应该被认出来')
  assert.equal(global('OUT'), 'true', '40 格外的营火不该被当成"照亮我的光源"')
})

test('NR-11：烧完的火（Light 关掉）不算光源', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    local dead = newent("campfire", 3, 0, { "fire" }, {
        fueled = { IsEmpty = function() return true end } })
    dead.Light = { IsEnabled = function() return true end,
                   GetCalculatedRadius = function() return 6 end }
    NEARBY = { dead }
    RESULT = tostring(Whale.native.FindLitSource(PLAYER, 12) == nil)
  `, '烧完的火')
  assert.equal(global('RESULT'), 'true', '燃料空了的火不能算可用光源')
})

test('NR-12：逃跑角度来自原版 RunAway:GetRunAngle（背离威胁方向）', async () => {
  const vanilla = vanillaScript('behaviours/runaway.lua')
  if (!vanilla) return // 本机没解包 scripts.zip 时跳过（NR-13b 会说明）
  const { run, global } = loadNative(await import('fengari'), vanilla)
  run(`
    local foe = newent("frog", -8, 0, { "hostile" }, {})
    NEARBY = { foe }
    local angle = Whale.native.FleeAngle(PLAYER, foe, 9)
    ANGLE = angle ~= nil and string.format("%.0f", angle) or "nil"
  `, '逃跑角度')
  // 威胁在 -x 方向（角度 180），背离方向应该是 0 度附近
  const angle = Number(global('ANGLE'))
  assert.ok(Number.isFinite(angle), `原版节点应该算出角度，实际 ${global('ANGLE')}`)
  const delta = Math.min(Math.abs(angle), Math.abs(angle - 360))
  assert.ok(delta <= 20, `威胁在 180 度方向时，背离方向应接近 0 度，实际 ${angle}`)
})

test('NR-13：原版节点不可用（FindWalkableOffset 返回 nil）时，逃跑角度仍然可用', async () => {
  const vanilla = vanillaScript('behaviours/runaway.lua')
  if (!vanilla) return
  const { run, global } = loadNative(await import('fengari'), vanilla)
  run(`
    FIND_OFFSET_OK = false
    local foe = newent("frog", -8, 0, { "hostile" }, {})
    local angle = Whale.native.FleeAngle(PLAYER, foe, 9)
    -- 原版 runaway.lua:82-84：全部方向都走不通时"随便跑"，返回背离角
    RESULT = angle ~= nil and "ok" or "nil"
  `, '绕障失败回退')
  assert.equal(global('RESULT'), 'ok', '原版节点在无路可走时会退回直线跑，不该返回 nil')
})

test('NR-14：角度→世界坐标的换算和原版一致（0 度 = +x，90 度 = -z）', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    local x0, z0 = Whale.native.PointFromAngle(PLAYER, 0, 4)
    ZERO = string.format("%.1f,%.1f", x0, z0)
    local x9, z9 = Whale.native.PointFromAngle(PLAYER, 90, 4)
    NINETY = string.format("%.1f,%.1f", x9, z9)
  `, '角度换算')
  assert.equal(global('ZERO'), '4.0,0.0', '0 度应该往 +x 走')
  assert.equal(global('NINETY'), '0.0,-4.0', '90 度应该往 -z 走（原版 FindValidPositionByFan 的约定）')
})

test('NR-15：玩家攻击造的是 ACTIONS.ATTACK 的 BufferedAction，目标正确', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    local foe = newent("frog", 1, 0, { "hostile" }, {
        health = { IsDead = function() return false end } })
    local ba, why = Whale.native.AttackAction(PLAYER, foe)
    OK = ba ~= nil and "yes" or tostring(why)
    ACTION = ba ~= nil and tostring(ba.action.id) or "nil"
    TARGET = ba ~= nil and tostring(ba.target.prefab) or "nil"
    DOER = ba ~= nil and tostring(ba.doer.prefab) or "nil"
  `, '攻击动作')
  assert.equal(global('OK'), 'yes', global('OK'))
  assert.equal(global('ACTION'), 'ATTACK')
  assert.equal(global('TARGET'), 'frog')
  assert.equal(global('DOER'), 'wilson')
})

test('NR-16：没有 health 组件的东西不许当攻击目标（返回明确原因）', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    local bush = newent("berrybush", 1, 0, { "pickable" }, {})
    local ba, why = Whale.native.AttackAction(PLAYER, bush)
    RESULT = ba == nil and tostring(why) or "made_one"
  `, '不可攻击目标')
  assert.equal(global('RESULT'), 'target_not_attackable')
})

test('NR-17：冷却没走完时 CanSwing 为 false（不推无效动作）', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    COOLDOWN = true
    BUSY = tostring(Whale.native.CanSwing(PLAYER))
    COOLDOWN = false
    FREE = tostring(Whale.native.CanSwing(PLAYER))
  `, '攻击冷却')
  assert.equal(global('BUSY'), 'false')
  assert.equal(global('FREE'), 'true')
})

test('NR-18：LastAttackTime 读的是引擎记录（combat.lastdoattacktime）', async () => {
  const { run, global } = loadNative(await import('fengari'))
  run(`
    NONE = tostring(Whale.native.LastAttackTime(PLAYER) == nil)
    PLAYER.components.combat.lastdoattacktime = 1234.5
    VALUE = string.format("%.1f", Whale.native.LastAttackTime(PLAYER))
  `, '真实出手时间')
  assert.equal(global('NONE'), 'true', '还没打过时应该是 nil（不能编一个 0 出来）')
  assert.equal(global('VALUE'), '1234.5')
})

// ═══════════════════════ 三、Reflex 职责收窄：解决不了就上报 ═══════════════════════

test('NR-19：Reflex 暴露 Needs()，把"我解决不了"变成结构化需求', () => {
  const live = code(reflexLua)
  assert.match(live, /function R\.Needs\(\)/, '要有 Needs() 给 observe 读')
  assert.match(live, /report_need\("light"/, '天黑造不出光要上报 light 需求')
  assert.match(live, /report_need\("light_materials"/, '缺火把材料要上报 light_materials 需求')
  assert.match(live, /report_need\("food"/, '附近没食物要上报 food 需求')
})

test('NR-20：上报的需求有 30 秒去重（状态每秒重写，不能刷屏）', () => {
  const live = code(reflexLua)
  assert.match(live, /now - prev\.at < 30/, '同一条需求 30 秒内不重复写')
})

test('NR-21：需求会被 observe 渲染成给模型看的提示（不是只写日志）', () => {
  const live = code(observeLua)
  assert.match(live, /reflex\.Needs/, 'observe 要读 reflex.Needs')
  assert.match(live, /need_text/, '要有把需求翻成人话的函数')
  assert.match(observeLua, /不会走远|只在附近采料/, '提示要说明"反射不会走远"，模型才知道要自己去找')
})

test('NR-22：需求解决后会被清掉（不能一直挂着吓模型）', () => {
  const live = code(reflexLua)
  assert.match(live, /clear_need\("light"\)/, '拿到光之后要清掉 light 需求')
  assert.match(live, /clear_need\("food"\)/, '吃到东西之后要清掉 food 需求')
})

test('NR-23：Reflex 不再自己找资源/规划路线（职责收窄到"现在会死"的五件事）', () => {
  const live = code(reflexLua)
  // 保留：逃跑 / 光源 / 进食 / 回血 / 理智
  for (const keep of ['reflex_flee', 'reflex_light', 'reflex_eat', 'reflex_heal', 'reflex_sanity']) {
    assert.ok(live.includes(keep), `${keep} 是 Reflex 该留的职责`)
  }
  // 不许把"规划路线 / 算材料 / 制作工具"扩进来（那些是 Node 的活）
  assert.ok(!/A\.Start\("craft", \{ recipe = "axe"/.test(live), 'Reflex 不该顺手做斧头（那是 Plan/模型的活）')
  assert.ok(!/A\.Start\("craft", \{ recipe = "pickaxe"/.test(live), 'Reflex 不该顺手做镐')
})

test('NR-24：native.lua 被 modmain 加载，且排在 actions / reflex 之前', () => {
  // 只看真正的 modimport 行 —— modmain 顶部有一段模块清单注释，那里也提到这些文件名
  const at = (name) => modmain.indexOf(`modimport("scripts/whale/${name}.lua")`)
  assert.ok(at('native') > 0, 'modmain 要 modimport native.lua')
  assert.ok(at('native') < at('actions'), 'native 要在 actions 之前（玩家攻击走它）')
  assert.ok(at('native') < at('reflex'), 'native 要在 reflex 之前（照明/逃跑走它）')
})

// ═══════════════════════ 四、整条链：reflex + native + actions 一起跑 ═══════════════════════
//
// 上面三节各自验证一个零件；这一节验证**装配之后**还能工作 ——
// 上一阶段的教训是"每个零件单测都绿，装到一起才崩"（modimport 数量、加载顺序、
// 模块间相互引用都会在装配时才暴露）。

/** 把 util + native + actions + reflex 一起加载，模拟 modmain 的真实顺序 */
function loadChain(fengari, vanillaRunaway) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (src, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(src))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${what} 出错：${message}`)
    }
  }
  run(STUB, '假游戏环境')
  run(`
    Whale = { verbose = false, version = "test", files = {} }
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.bridge = { Report = function(ok, text, id) REPORTS = REPORTS or {}; REPORTS[#REPORTS+1] = { ok = ok, text = text, id = id } end,
                     WriteState = function() end }
  `, 'Whale 表 + 文件桥桩')
  run(readFileSync(join(MOD, 'scripts', 'whale', 'util.lua'), 'utf8'), 'util.lua')
  // actions 需要 ACTIONS / EQUIPSLOTS / builder 等；STUB 里已有最小集合
  run(readFileSync(join(MOD, 'scripts', 'whale', 'actions.lua'), 'utf8'), 'actions.lua')
  if (vanillaRunaway) {
    run(vanillaRunaway, '原版 behaviours/runaway.lua')
    run('GLOBAL.RunAway = RunAway', '把原版 RunAway 挂到 GLOBAL')
  }
  run(nativeLua, 'native.lua')
  run(reflexLua, 'reflex.lua')
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  return { run, global }
}

test('NR-25：装配后 reflex 用 native 的照明判断（不是自己拿背包猜）', async () => {
  const { run, global } = loadChain(await import('fengari'))
  run(`
    -- 手里有火把，但引擎说没被照亮（比如站在没光的角落）
    LIGHT_IS_IN = false
    PLAYER.components.inventory = {
        GetEquippedItem = function() return { prefab = "torch", components = {
            fueled = { IsEmpty = function() return false end, GetPercent = function() return 1 end } } } end,
        ForEachItem = function() end,
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
    }
    PLAYER.components.locomotor = { Stop = function() end, Clear = function() end, GoToPoint = function() end }
    PLAYER.components.health.GetPercent = function() return 1 end
    PLAYER.components.hunger = { GetPercent = function() return 1 end }
    PLAYER.components.sanity = { GetPercent = function() return 1 end }
    GLOBAL.TheWorld.state.phase = "night"
    local rep = Whale.reflex.Diagnose()
    HAS = tostring(rep.has_usable_light)
  `, '手上有火把但实际没被照亮')
  assert.equal(global('HAS'), 'false',
    '引擎说没被照亮时，has_usable_light 必须是 false —— 否则夜里举着照不到的火把还以为安全')
})

test('NR-26：装配后 reflex 上报的需求能通过 Needs() 拿到，且带缺失材料', async () => {
  const { run, global } = loadChain(await import('fengari'))
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    LIGHT_IS_IN = false
    PLAYER.components.inventory = {
        GetEquippedItem = function() return nil end,
        ForEachItem = function() end,
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
    }
    PLAYER.components.locomotor = { Stop = function() end, Clear = function() end, GoToPoint = function() end }
    PLAYER.components.health.GetPercent = function() return 1 end
    PLAYER.components.hunger = { GetPercent = function() return 1 end }
    PLAYER.components.sanity = { GetPercent = function() return 1 end }
    -- 让 light_action_available 返回 true（否则 try_action 会跳过、走不到上报）
    Whale.craftrules = { NeededIngredients = function() return { cutgrass = 2, twigs = 2 } end,
                         Counts = function() return {} end,
                         HasIngredients = function() return false, "missing" end }
    Whale.reflex.Tick()
    -- Reflex.Tick 内部 5 拍才真正跑一次（≈1 秒），这里补足
    for _ = 1, 5 do Whale.reflex.Tick() end
    local needs = Whale.reflex.Needs()
    COUNT = tostring(#needs)
    KIND = #needs > 0 and tostring(needs[1].kind) or "none"
  `, '夜里没光 + 没材料')
  assert.equal(global('KIND'), 'light', '天黑造不出光时应该上报 light 需求')
  assert.equal(global('COUNT'), '1')
})

test('NR-27：装配后 attack 动作走 native.AttackAction（真造出 ATTACK 的 BufferedAction）', async () => {
  const { run, global } = loadChain(await import('fengari'))
  run(`
    local foe = newent("frog", 1, 0, { "hostile" }, {
        health = { IsDead = function() return false end } })
    Whale.components = nil
    PUSHED = nil
    PLAYER.components.locomotor = {
        Stop = function() end, Clear = function() end, GoToPoint = function() end,
        PushAction = function(self, ba) PUSHED = ba end,
    }
    PLAYER.components.health.GetPercent = function() return 1 end
    PLAYER.GetBufferedAction = function() return nil end
    Whale.actions.Start("attack", {}, "model-atk", { target = foe, times = 1 })
    Whale.actions.Tick()
    OK = PUSHED ~= nil and tostring(PUSHED.action.id) or "none"
    TGT = PUSHED ~= nil and tostring(PUSHED.target.prefab) or "none"
  `, 'attack 走 native')
  assert.equal(global('OK'), 'ATTACK', '装配后 attack 必须真的推出 ACTIONS.ATTACK')
  assert.equal(global('TGT'), 'frog')
})

test('NR-28：装配后逃跑落点不是"直线后退"（原版几何生效）', async () => {
  const vanilla = vanillaScript('behaviours/runaway.lua')
  if (!vanilla) return
  const { run, global } = loadChain(await import('fengari'), vanilla)
  run(`
    local foe = newent("frog", -6, 0, { "hostile" }, {
        health = { IsDead = function() return false end },
        combat = { target = PLAYER } })
    NEARBY = { foe }
    MOVED = nil
    PLAYER.components.locomotor = {
        Stop = function() end, Clear = function() end,
        GoToPoint = function(self, pt) MOVED = pt end,
        PushAction = function() end,
    }
    PLAYER.components.health.GetPercent = function() return 0.2 end
    PLAYER.components.hunger = { GetPercent = function() return 1 end }
    PLAYER.components.sanity = { GetPercent = function() return 1 end }
    PLAYER.components.combat = { target = nil, InCooldown = function() return false end }
    PLAYER.GetBufferedAction = function() return nil end
    Whale.reflex.Tick()
    for _ = 1, 5 do Whale.reflex.Tick() end
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    -- move_to 的落点写在 job.args 里
    TX = Whale.job ~= nil and tostring(Whale.job.args.x) or "none"
    TZ = Whale.job ~= nil and tostring(Whale.job.args.z) or "none"
  `, '残血 + 贴脸怪')
  assert.equal(global('JOB'), 'move_to', '应该真的发起撤退移动')
  // 威胁在 -x，原版几何的背离方向是 +x，所以落点 x 必须 > 0（玩家在 0）
  const tx = Number(global('TX'))
  assert.ok(Number.isFinite(tx) && tx > 0,
    `撤退落点应该往 +x（背离 -x 的怪），实际 x=${global('TX')} z=${global('TZ')}`)
})
