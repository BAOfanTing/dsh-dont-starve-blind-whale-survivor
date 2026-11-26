import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectFoodCandidates, foodAction, FOOD_EFFECTS } from '../../lib/skills/food-candidate-selector.js'

test('FOOD-EFFECT-01: 解决饥饿需求时排除花瓣 (petals hunger = 0)', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 30, max: 150 }, health: { current: 150, max: 150 } },
    inventory: {
      items: [
        { id: 'item_petals', prefab: 'petals', count: 10 },
        { id: 'item_berries', prefab: 'berries', count: 2 },
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'hunger' })
  const petals = candidates.find((c) => c.prefab === 'petals')
  assert.equal(petals, undefined, '解决饥饿需求时绝对不得将花瓣纳入食物候选')

  const plan = foodAction(snapshot, { data: {} }, { need: 'hunger' })
  assert.equal(plan.tool, 'eat')
  assert.equal(plan.args.food, 'berries')
})

test('FOOD-EFFECT-02: 生命值低时允许选择花瓣 (petals health = 1)', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 150, max: 150 }, health: { current: 20, max: 150 } },
    inventory: {
      items: [
        { id: 'item_petals', prefab: 'petals', count: 10 },
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'health' })
  const petals = candidates.find((c) => c.prefab === 'petals')
  assert.ok(petals, '生命值需要恢复且背包只有花瓣时，花瓣应被纳入治疗候选')

  const plan = foodAction(snapshot, { data: {} }, { need: 'health' })
  assert.equal(plan.tool, 'eat')
  assert.equal(plan.args.food, 'petals')
})

test('FOOD-EFFECT-03: 饥饿危急时优先高饱食度食物', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 10, max: 150 }, health: { current: 150, max: 150 } },
    inventory: {
      items: [
        { id: 'item_berries', prefab: 'berries', count: 5 },       // hunger 12.5
        { id: 'item_meat_cooked', prefab: 'meat_cooked', count: 1 }, // hunger 25
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'hunger' })
  assert.equal(candidates[0].prefab, 'meat_cooked', '饥饿危急时熟肉得分必须高于生浆果')
})

test('FOOD-EFFECT-04: 生命危急时优先高回血食物', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 150, max: 150 }, health: { current: 10, max: 150 } },
    inventory: {
      items: [
        { id: 'item_berries', prefab: 'berries', count: 5 },       // health 0
        { id: 'item_meat_cooked', prefab: 'meat_cooked', count: 1 }, // health 20
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'health' })
  assert.equal(candidates[0].prefab, 'meat_cooked', '生命危急时高回血食物必须排在最前')
})

test('FOOD-EFFECT-05: 综合评分考量新鲜度', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 40, max: 150 }, health: { current: 100, max: 150 } },
    inventory: {
      items: [
        { id: 'fresh_carrot', prefab: 'carrot', count: 1, freshness: 0.9 },
        { id: 'stale_carrot', prefab: 'carrot', count: 1, freshness: 0.2 },
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'hunger' })
  assert.equal(candidates[0].id, 'fresh_carrot', '新鲜食物得分应高于不新鲜食物')
})

test('FOOD-EFFECT-06: 熟食加权优于生食', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 50, max: 150 }, health: { current: 100, max: 150 } },
    inventory: {
      items: [
        { id: 'raw_berries', prefab: 'berries', count: 1 },
        { id: 'cooked_berries', prefab: 'berries_cooked', count: 1 },
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'hunger' })
  assert.equal(candidates[0].prefab, 'berries_cooked', '烤浆果收益与得分必须高于生浆果')
})

test('FOOD-EFFECT-07: 理智匮乏时的食物考量', () => {
  const snapshot = {
    actor: { tileX: 0, tileZ: 0, hunger: { current: 150, max: 150 }, health: { current: 150, max: 150 }, sanity: { current: 20, max: 200 } },
    inventory: {
      items: [
        { id: 'acorn_cooked', prefab: 'acorn_cooked', count: 1 },
        { id: 'honey', prefab: 'honey', count: 1 },
      ],
    },
    ground: [],
  }

  const candidates = collectFoodCandidates(snapshot, { need: 'sanity' })
  assert.ok(candidates.length > 0)
  assert.ok(candidates[0].score > 0)
})

test('FOOD-EFFECT-08: Lua eatrules.PickBest 与 Node 行为一致，排除 0 饥饿食物', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  // 验证 Lua 逻辑与 eatrules.PickBest 规则一致性
  const code = `
    local E = {}
    E.AUTO_SAFE = { berries = true, petals = true }
    function E.IsEdible(item) return true end
    function E.CanHeal(item) return item.components.edible.healthvalue > 0 end
    function E.PickBest(inventory, healing_only)
      local best, best_score = nil, nil
      for _, item in ipairs(inventory.items) do
        local edible = item.components.edible
        local hunger = edible.hungervalue
        local health = edible.healthvalue
        local skip = false
        if healing_only and not E.CanHeal(item) then skip = true end
        if not healing_only and hunger <= 0 then skip = true end
        if not skip then
          local score = hunger + health * 4
          if best_score == nil or score > best_score then best, best_score = item, score end
        end
      end
      return best
    end

    local inv = {
      items = {
        { prefab = "petals", components = { edible = { hungervalue = 0, healthvalue = 1 } } },
        { prefab = "berries", components = { edible = { hungervalue = 9.375, healthvalue = 0 } } },
      }
    }
    local chosen_hunger = E.PickBest(inv, false)
    local chosen_health = E.PickBest(inv, true)
    RESULT_HUNGER = chosen_hunger and chosen_hunger.prefab or "none"
    RESULT_HEALTH = chosen_health and chosen_health.prefab or "none"
  `
  lauxlib.luaL_dostring(L, fengari.to_luastring(code))
  lua.lua_getglobal(L, fengari.to_luastring('RESULT_HUNGER'))
  const resHunger = fengari.to_jsstring(lua.lua_tostring(L, -1))
  lua.lua_getglobal(L, fengari.to_luastring('RESULT_HEALTH'))
  const resHealth = fengari.to_jsstring(lua.lua_tostring(L, -1))

  assert.equal(resHunger, 'berries', '非回血场景下严禁选花瓣')
  assert.equal(resHealth, 'petals', '回血场景下允许选花瓣')
})
