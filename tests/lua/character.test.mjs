// R8.2：温蒂角色档案 + 阿比盖尔协同（Fengari 真实加载 character/*.lua）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale')

const STUB = `
GLOBAL = { TUNING = { ABIGAIL_DEFENSIVE_MAX_FOLLOW = 20, ABIGAIL_HEALTH_LEVEL1 = 150, ABIGAIL_HEALTH_LEVEL2 = 300, ABIGAIL_HEALTH_LEVEL3 = 600,
    WENDY_HEALTH = 150, WENDY_HUNGER = 150, WENDY_SANITY = 200, WENDY_SANITY_MULT = 0.75, WENDY_DAMAGE_MULT = 0.75 } }
Whale = {}
function make_ghost(opts)
  opts = opts or {}
  local g = { prefab = "abigail", components = {} }
  local dead = opts.dead == true
  g.components.health = { IsDead = function() return dead end, GetPercent = function() return opts.hp or 1.0 end }
  g.components.combat = { target = opts.target }
  function g:IsValid() return opts.valid ~= false end
  function g:HasTag(tag) if tag == "INLIMBO" then return opts.inlimbo == true end return false end
  g.Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end }
  return g
end
function make_player(prefab, ghost)
  local p = { prefab = prefab, components = {} }
  if ghost ~= false then p.components.ghostlybond = { ghost = ghost } end
  p.Transform = { GetWorldPosition = function() return 0, 0, 0 end }
  return p
end
`

async function loadChar() {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${what} 出错：${m}`)
    }
  }
  const load = (rel) => run(readFileSync(join(MOD, rel), 'utf8'), rel)
  run(STUB, 'STUB')
  load('character/base-profile.lua')
  load('character/profiles/wendy.lua')
  load('character/profile-registry.lua')
  load('character/companion.lua')
  const global = (name) => { lua.lua_getglobal(L, to_luastring(name)); try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } }
  return { run, global }
}

// ── 角色识别 ──
test('wendy prefab 识别为 wendy profile', async () => {
  const { run, global } = await loadChar()
  run(`local p = make_player("wendy", false); local prof = Whale.character.Resolve(p); R = prof.id`, '')
  assert.equal(global('R'), 'wendy')
})
test('其他角色用 base profile', async () => {
  const { run, global } = await loadChar()
  run(`R = Whale.character.Resolve(make_player("wilson", false)).id`, '')
  assert.equal(global('R'), 'base')
})
test('未知/nil 不崩溃，回退 base', async () => {
  const { run, global } = await loadChar()
  run(`local a = Whale.character.Resolve(nil); local b = Whale.character.Resolve({ prefab = "unknown_x", components = {} }); R = a.id .. "/" .. b.id`, '')
  assert.equal(global('R'), 'base/base')
})
test('角色切换后 Profile 正确更新', async () => {
  const { run, global } = await loadChar()
  run(`local p = make_player("wendy", false); local a = Whale.character.Resolve(p).id; p.prefab = "wilson"; local b = Whale.character.Resolve(p).id; R = a .. "->" .. b`, '')
  assert.equal(global('R'), 'wendy->base')
})
test('温蒂理智策略不污染通用角色', async () => {
  const { run, global } = await loadChar()
  run(`
    local wp = make_player("wendy", false)
    local bp = make_player("wilson", false)
    local ws = Whale.character.Resolve(wp).GetSanityPolicy(wp)
    local bs = Whale.character.Resolve(bp).GetSanityPolicy(bp)
    R = tostring(ws.drain_mult) .. "/" .. tostring(bs.drain_mult) .. "/" .. tostring(ws.warn == bs.warn)
  `, '')
  const [wd, bd, same] = global('R').split('/')
  assert.equal(wd, '0.75')
  assert.equal(bd, '1.0')
  assert.equal(same, 'false')
})

// ── 阿比盖尔状态 ──
test('阿比盖尔存在时状态识别正确（存活/血量/距离/可协助）', async () => {
  const { run, global } = await loadChar()
  run(`local g = make_ghost({ hp = 0.8, x = 40 }); local p = make_player("wendy", g); local s = Whale.character.GetCompanionState(p); R = tostring(s.present)..","..tostring(s.alive)..","..tostring(s.can_assist)..","..tostring(s.unknown)`, '')
  assert.equal(global('R'), 'true,true,true,false')
})
test('阿比盖尔不在场（ghost=nil）→ present=false', async () => {
  const { run, global } = await loadChar()
  run(`local p = make_player("wendy", nil); local s = Whale.character.GetCompanionState(p); R = tostring(s.present)..","..tostring(s.can_assist)`, '')
  assert.equal(global('R'), 'false,false')
})
test('阿比盖尔死亡 → alive=false、can_assist=false', async () => {
  const { run, global } = await loadChar()
  run(`local g = make_ghost({ dead = true, x = 20 }); local p = make_player("wendy", g); local s = Whale.character.GetCompanionState(p); R = tostring(s.alive)..","..tostring(s.can_assist)`, '')
  assert.equal(global('R'), 'false,false')
})
test('阿比盖尔重新出现后恢复协同', async () => {
  const { run, global } = await loadChar()
  run(`local p = make_player("wendy", nil); local s1 = Whale.character.GetCompanionState(p).can_assist; p.components.ghostlybond.ghost = make_ghost({ x = 10 }); local s2 = Whale.character.GetCompanionState(p).can_assist; R = tostring(s1).."->"..tostring(s2)`, '')
  assert.equal(global('R'), 'false->true')
})
test('太远时不可协助', async () => {
  const { run, global } = await loadChar()
  run(`local g = make_ghost({ x = 400 }); local p = make_player("wendy", g); R = tostring(Whale.character.GetCompanionState(p).can_assist)`, '')
  assert.equal(global('R'), 'false')
})
test('非伴生角色（无 ghostlybond）→ unknown=true、不假定可协助', async () => {
  const { run, global } = await loadChar()
  run(`local p = make_player("wilson", false); local s = Whale.character.GetCompanionState(p); R = tostring(s.unknown)..","..tostring(s.can_assist)`, '')
  assert.equal(global('R'), 'true,false')
})

// ── 敌人分类 / 战斗策略 ──
test('真实 prefab 分类正确', async () => {
  const { run, global } = await loadChar()
  run(`
    local C = Whale.character
    R = C.ClassifyEnemy("spider").kind .. "," .. tostring(C.ClassifyEnemy("spider").hunt_allowed)
      .. "|" .. C.ClassifyEnemy("spider_warrior").kind
      .. "|" .. C.ClassifyEnemy("spiderqueen").kind .. "," .. tostring(C.ClassifyEnemy("spiderqueen").hunt_allowed)
      .. "|" .. C.ClassifyEnemy("beefalo").kind
  `, '')
  assert.equal(global('R'), 'spider_common,true|spider_warrior|spider_queen,false|other')
})
test('温蒂需阿比盖尔才主动狩猎；通用角色不需要', async () => {
  const { run, global } = await loadChar()
  run(`
    local wp = make_player("wendy", false); local bp = make_player("wilson", false)
    local wc = Whale.character.Resolve(wp).GetCombatPolicy(wp)
    local bc = Whale.character.Resolve(bp).GetCombatPolicy(bp)
    R = tostring(wc.requires_companion_for_hunt)..","..tostring(wc.preferred_strategy)..","..tostring(bc.requires_companion_for_hunt)
  `, '')
  assert.equal(global('R'), 'true,abigail_assisted,false')
})

// ── 集成源码断言（不重造模拟，直接盯真实产物接线）──
test('observe/battle/snapshot 已接入角色与伴生', () => {
  const obs = readFileSync(join(MOD, 'observe.lua'), 'utf8')
  const bat = readFileSync(join(MOD, 'battle.lua'), 'utf8')
  const snap = readFileSync(join(ROOT, 'lib', 'state', 'snapshot.js'), 'utf8')
  const modmain = readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'modmain.lua'), 'utf8')
  assert.match(obs, /Whale\.character\.Resolve/, 'observe 必须用 Profile 解析角色')
  assert.match(obs, /GetCompanionState/, 'observe 必须暴露阿比盖尔状态')
  assert.match(bat, /companion_not_ready/, 'battle 起手必须有伴生闸')
  assert.match(bat, /requires_companion_for_hunt/, 'battle 必须读战斗策略')
  assert.match(snap, /character: isNew/, 'snapshot 必须透传 character')
  assert.match(modmain, /character\/profile-registry\.lua/, 'modmain 必须加载角色 Profile')
})
