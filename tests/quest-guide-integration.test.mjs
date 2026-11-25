// 任务手册运行时直读与自主追踪集成测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { questGuideTasksFor, isQuestCompleted } from '../lib/planner/quest-guide-adapter.js'
import { evaluateTarget, mergeBoard, pickNextTask, BOARD_SCHEMA } from '../lib/planner/task-board.js'
import { createPlanner } from '../lib/planner/planner-core.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { arbitrate, renderDecision } from '../lib/planner/decision-arbiter.js'

test('QG-1: questGuideTasksFor 材料不足时生成采集依赖', () => {
  const questGuide = {
    installed: true,
    tracked_task: {
      id: 'a1',
      title: '制作火炬',
      desc: '夜晚没有光源会被查理攻击。先做一支火炬。',
      season: 'autumn',
      icon: 'torch',
      mats: [
        { icon: 'cutgrass', name: '采下的草', n: 2 },
        { icon: 'twigs', name: '树枝', n: 2 },
      ],
      auto: [
        [{ k: 'craft', p: ['torch'], n: 1 }],
      ],
      done: false,
    },
  }

  // 背包里什么都没有
  const emptySnapshot = { player: { inventory: { items: [] } } }
  const tasks = questGuideTasksFor({ questGuide, snapshot: emptySnapshot, now: 1000 })

  assert.equal(tasks.length, 3, '应当生成 2 个采集前置任务 + 1 个制作主任务')
  const mainTask = tasks.find((t) => t.id === 'qg_a1')
  assert.ok(mainTask, '应存在主任务 qg_a1')
  assert.equal(mainTask.skill_id, 'craft_or_build')
  assert.equal(mainTask.skill_args.recipe, 'torch')
  assert.deepEqual(mainTask.depends_on.sort(), ['gather_for_a1_cutgrass', 'gather_for_a1_twigs'].sort())

  const grassTask = tasks.find((t) => t.id === 'gather_for_a1_cutgrass')
  assert.ok(grassTask)
  assert.equal(grassTask.skill_id, 'gather_resources')
  assert.equal(grassTask.skill_args.target_items.cutgrass, 2)
})

test('QG-2: questGuideTasksFor 材料足够时直接准备制作', () => {
  const questGuide = {
    installed: true,
    tracked_task: {
      id: 'a1',
      title: '制作火炬',
      icon: 'torch',
      mats: [
        { icon: 'cutgrass', name: '采下的草', n: 2 },
        { icon: 'twigs', name: '树枝', n: 2 },
      ],
      auto: [
        [{ k: 'craft', p: ['torch'], n: 1 }],
      ],
      done: false,
    },
  }

  // 背包里材料齐了
  const readySnapshot = {
    player: {
      inventory: {
        items: [
          { prefab: 'cutgrass', count: 5 },
          { prefab: 'twigs', count: 3 },
        ],
      },
    },
  }

  const tasks = questGuideTasksFor({ questGuide, snapshot: readySnapshot, now: 1000 })
  assert.equal(tasks.length, 1, '材料齐全时无需生成采集任务')
  assert.equal(tasks[0].id, 'qg_a1')
  assert.deepEqual(tasks[0].depends_on, [], '无依赖')
  assert.equal(tasks[0].priority, 1)
})

test('QG-3: 任务完成证据判定 (evaluateTarget quest_complete)', () => {
  const target = {
    type: 'quest_complete',
    quest_id: 'a1',
    fallback_prefab: 'torch',
    count: 1,
  }

  // 1. 游戏内已打钩
  const doneSnapshot = {
    quest_guide: {
      installed: true,
      done_tasks: { a1: true },
    },
  }
  const res1 = evaluateTarget(target, doneSnapshot)
  assert.equal(res1.done, true, '游戏内打钩应立即判定为已完成')

  // 2. 游戏内未打钩但身上已有火把（双重兜底）
  const torchSnapshot = {
    quest_guide: { installed: true, done_tasks: {} },
    player: { inventory: { items: [{ prefab: 'torch', count: 1 }] } },
  }
  const res2 = evaluateTarget(target, torchSnapshot)
  assert.equal(res2.done, true, '手上有成品也判定完成')

  // 3. 既未打钩也没成品
  const pendingSnapshot = {
    quest_guide: { installed: true, done_tasks: {} },
    player: { inventory: { items: [] } },
  }
  const res3 = evaluateTarget(target, pendingSnapshot)
  assert.equal(res3.done, false)
})

test('QG-4: Planner Core 自动切换为任务手册自主追踪', () => {
  const store = {
    load: () => ({ current_stage: 0, completed_milestones: [] }),
    save: () => {},
  }
  const planner = createPlanner({ memoryStore: store, now: () => 1000 })

  const snapshot = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 1, snapshot_id: 's1', timestamp: 1000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 100, max: 100 },
        hunger: { current: 150, max: 150 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [{ prefab: 'cutgrass', count: 4 }, { prefab: 'twigs', count: 4 }] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        tracked_task: {
          id: 'a1',
          title: '制作火炬',
          desc: '夜晚没有光源会被查理攻击。先做一支火炬。',
          season: 'autumn',
          icon: 'torch',
          mats: [
            { icon: 'cutgrass', name: '采下的草', n: 2 },
            { icon: 'twigs', name: '树枝', n: 2 },
          ],
          auto: [
            [{ k: 'craft', p: ['torch'], n: 1 }],
          ],
          done: false,
        },
        open_tasks: [],
        done_count: 0,
      },
    },
  })

  assert.ok(snapshot.quest_guide, '归一化快照应保留 quest_guide')
  const planResult = planner.plan(snapshot)

  assert.ok(planResult.board, '应当生成看板')
  assert.ok(planResult.board.goal.includes('任务手册自主追踪'), '目标描述应标明由任务手册驱动')
  assert.ok(planResult.nextTask, '应当选中下一步任务')
  assert.equal(planResult.nextTask.id, 'qg_a1')
  assert.ok(planResult.next.includes('制作火炬'), '下一步提示应清晰指引任务手册目标')
})

test('QG-5: 任务手册全流程生命周期闭环推进', () => {
  const store = {
    _mem: { current_stage: 0, completed_milestones: [] },
    load() { return this._mem },
    save(m) { this._mem = m },
  }
  const planner = createPlanner({ memoryStore: store, now: () => 1000 })

  // 步骤 1：开始时身上空空，任务手册追踪制作火炬
  const snap1 = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 1, snapshot_id: 's1', timestamp: 1000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 100, max: 100 },
        hunger: { current: 150, max: 150 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        tracked_task: {
          id: 'a1',
          title: '制作火炬',
          season: 'autumn',
          icon: 'torch',
          mats: [
            { icon: 'cutgrass', name: '采下的草', n: 2 },
            { icon: 'twigs', name: '树枝', n: 2 },
          ],
          auto: [[{ k: 'craft', p: ['torch'], n: 1 }]],
          done: false,
        },
        open_tasks: [],
        done_count: 0,
      },
    },
  })

  const res1 = planner.plan(snap1)
  assert.ok(res1.nextTask.id.startsWith('gather_for_a1_'), '材料不足应先收集材料')

  // 步骤 2：收集完材料后再次 plan，主任务就绪
  const snap2 = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 2, snapshot_id: 's2', timestamp: 2000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 100, max: 100 },
        hunger: { current: 150, max: 150 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 2 }] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        tracked_task: {
          id: 'a1',
          title: '制作火炬',
          season: 'autumn',
          icon: 'torch',
          mats: [
            { icon: 'cutgrass', name: '采下的草', n: 2 },
            { icon: 'twigs', name: '树枝', n: 2 },
          ],
          auto: [[{ k: 'craft', p: ['torch'], n: 1 }]],
          done: false,
        },
        open_tasks: [],
        done_count: 0,
      },
    },
  })

  const res2 = planner.plan(snap2)
  assert.equal(res2.nextTask.id, 'qg_a1', '材料收集完后应调度主任务')
  assert.equal(res2.nextTask.skill_id, 'craft_or_build')

  // 步骤 3：火把做好了，游戏内打钩，换下一个任务 a2（做斧头和镐）
  const snap3 = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 3, snapshot_id: 's3', timestamp: 3000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 100, max: 100 },
        hunger: { current: 150, max: 150 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [{ prefab: 'torch', count: 1 }] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        done_tasks: { a1: true },
        tracked_task: {
          id: 'a2',
          title: '做斧头和镐',
          season: 'autumn',
          icon: 'axe',
          mats: [{ icon: 'twigs', name: '树枝', n: 1 }, { icon: 'flint', name: '燧石', n: 1 }],
          auto: [[{ k: 'craft', p: ['axe'], n: 1 }]],
          done: false,
        },
        open_tasks: [],
        done_count: 1,
      },
    },
  })

  const res3 = planner.plan(snap3)
  // 看板中之前的 a1 任务已被判定 done，现在自动调度 a2
  const prevA1 = res3.board.tasks.find((t) => t.id === 'qg_a1')
  assert.equal(prevA1.status, 'done', 'a1 任务应被判定为 done')
  assert.ok(res3.nextTask.id.includes('a2'), '下一个调度目标应转入 a2')
})

test('QG-6: Lua 观察器端真实直读 qg_progress 组件与 Render 渲染', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

  const fail = () => {
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) throw new Error(`${what} 出错：${fail()}`)
  }

  // 基础沙箱与模块
  run(`
    GLOBAL = {}
    GLOBAL.pcall = pcall
    GLOBAL.tonumber = tonumber
    GLOBAL.tostring = tostring
    GLOBAL.type = type
    GLOBAL.math = math
    GLOBAL.table = table
    GLOBAL.string = string
    GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
    GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
    GLOBAL.ACTIONS = {}
    GLOBAL.AllPlayers = {}
    GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 } }
    GLOBAL.TheNet = { GetSessionIdentifier = function() return "s1" end, GetUserID = function() return "KU_1" end }
    GLOBAL.TheShard = { GetShardId = function() return "Master" end }

    -- 模拟 qg/logic
    local fake_logic = {
      byid = {
        a1 = { id = "a1", t = "制作火炬", d = "做一支火炬防夜间袭击", tab = "survival", season = "autumn" }
      },
      OpenTasks = function(state, season)
        return {
          { id = "a1", t = "制作火炬", d = "做一支火炬防夜间袭击", tab = "survival", season = "autumn" }
        }
      end
    }
    GLOBAL.require = function(path)
      if path == "qg/logic" then return fake_logic end
      return {}
    end

    Whale = { verbose = false, version = "0.41.2" }
  `, '假游戏环境')

  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }

  // 运行构建快照测试
  run(`
    local player = {
      prefab = "wilson",
      components = {
        health = { currenthealth = 150, maxhealth = 150, IsDead = function() return false end },
        hunger = { current = 150, max = 150 },
        sanity = { current = 200, max = 200 },
        inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end, GetEquippedItem = function() return nil end },
        qg_progress = {
          state = {
            track = "a1",
            done = {},
            prog = {},
          }
        }
      },
      Transform = { GetWorldPosition = function() return 0, 0, 0 end },
      IsValid = function() return true end,
      HasTag = function() return false end,
    }
    local text, data = Whale.observe.Build(player)
    TEST_DATA = data
    TEST_TEXT = text
  `, '执行 observe.Build')

  run(`
    assert(TEST_DATA.quest_guide ~= nil, "快照应包含 quest_guide")
    assert(TEST_DATA.quest_guide.installed == true, "quest_guide.installed 应为 true")
    assert(TEST_DATA.quest_guide.tracked_task ~= nil, "tracked_task 应存在")
    assert(TEST_DATA.quest_guide.tracked_task.title == "制作火炬", "tracked_task.title 应为制作火炬")
    assert(string.find(TEST_TEXT, "任务手册"), "渲染文本应包含任务手册信息")
    assert(string.find(TEST_TEXT, "制作火炬"), "渲染文本应包含制作火炬")
  `, '断言验证')
})

test('QG-7: 复合收集任务（多组 get 材料）正确拆解为采集依赖链并在材料集齐后完成', () => {
  const questGuide = {
    installed: true,
    tracked_task: {
      id: 'a31',
      title: '收集材料（备战科技）',
      season: 'autumn',
      mats: [
        { icon: 'log', name: '木头', n: 8 },
        { icon: 'rocks', name: '石头', n: 7 },
        { icon: 'twigs', name: '树枝', n: 6 },
        { icon: 'cutgrass', name: '采下的草', n: 4 },
        { icon: 'flint', name: '燧石', n: 2 },
        { icon: 'goldnugget', name: '金块', n: 1 },
      ],
      auto: [
        [{ k: 'get', p: ['log'], n: 8 }],
        [{ k: 'get', p: ['rocks'], n: 7 }],
        [{ k: 'get', p: ['cutgrass'], n: 4 }],
        [{ k: 'get', p: ['twigs'], n: 6 }],
        [{ k: 'get', p: ['flint'], n: 2 }],
        [{ k: 'get', p: ['goldnugget'], n: 1 }],
      ],
      done: false,
    },
  }

  // 背包里部分材料不足
  const snapshot = {
    player: {
      inventory: {
        items: [
          { prefab: 'log', count: 2 },
          { prefab: 'rocks', count: 2 },
          { prefab: 'twigs', count: 6 },
          { prefab: 'cutgrass', count: 4 },
          { prefab: 'flint', count: 2 },
        ],
      },
    },
  }

  const tasks = questGuideTasksFor({ questGuide, snapshot, now: 1000 })
  // 缺 log (差6), rocks (差5), goldnugget (差1)
  assert.equal(tasks.length, 4, '应生成 3 个采集依赖任务 + 1 个主任务')
  const logTask = tasks.find((t) => t.id === 'gather_for_a31_log')
  const rocksTask = tasks.find((t) => t.id === 'gather_for_a31_rocks')
  const goldTask = tasks.find((t) => t.id === 'gather_for_a31_goldnugget')
  const mainTask = tasks.find((t) => t.id === 'qg_a31')

  assert.ok(logTask && rocksTask && goldTask && mainTask)
  assert.deepEqual(mainTask.depends_on.sort(), ['gather_for_a31_goldnugget', 'gather_for_a31_log', 'gather_for_a31_rocks'].sort())
  assert.equal(mainTask.priority, 2, '有依赖时主任务优先级为 2')
})

test('QG-8: 接入任务手册时彻底清理旧阶段任务，旧建家任务不保留在看板中', () => {
  // 模拟之前世界记忆中残留了阶段 1 的建家和营地任务
  const store = {
    _mem: {
      current_stage: 1,
      completed_milestones: ['camp_site_selected'],
      camp_site: { x: -25, z: 48 },
      task_board: {
        schema: BOARD_SCHEMA,
        goal: '阶段 1 建立家园',
        tasks: [
          { id: 'choose_camp_site', title: '勘察营地', status: 'done', priority: 1 },
          { id: 'travel_to_camp', title: '前往营地', status: 'ready', priority: 1 },
          { id: 'gather_goldnugget', title: '收集金块', status: 'ready', priority: 2 },
          { id: 'build_first_structure', title: '建科学机器', status: 'blocked', priority: 1, depends_on: ['gather_goldnugget'] },
        ],
      },
    },
    load() { return this._mem },
    save(m) { this._mem = m },
  }

  const planner = createPlanner({ memoryStore: store, now: () => 1000 })
  const snapshot = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 10, snapshot_id: 's10', timestamp: 1000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 150, max: 150 },
        hunger: { current: 120, max: 150 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        open_tasks: [
          {
            id: 'a1',
            title: '制作火炬',
            mats: [{ icon: 'cutgrass', name: '草', n: 2 }, { icon: 'twigs', name: '树枝', n: 2 }],
            auto: [[{ k: 'craft', p: ['torch'], n: 1 }]],
          },
        ],
        done_tasks: {},
        done_count: 0,
      },
    },
  })

  const plan = planner.plan(snapshot)
  const taskIds = plan.board.tasks.map((t) => t.id)
  assert.ok(!taskIds.includes('travel_to_camp'), '旧阶段的 travel_to_camp 必须被清理')
  assert.ok(!taskIds.includes('build_first_structure'), '旧阶段的 build_first_structure 必须被清理')
  assert.ok(taskIds.includes('qg_a1'), '任务手册的 qg_a1 必须在看板中')

  // 验证 Decision Arbiter 渲染
  const decision = arbitrate(snapshot, { devPlan: plan, survivalPlan: null })
  assert.equal(decision.is_quest_guide_active, true)
  const renderedText = renderDecision(decision, plan)
  assert.ok(renderedText.includes('当前主线模式：任务手册自主追踪'), '应输出任务手册模式')
  assert.ok(!renderedText.includes('当前发展阶段：1 建立家园'), '不应输出旧阶段 1 建立家园')
})

test('QG-9: 生存受威胁状态下（survival.blocking），任务手册看板拓扑依然维持', () => {
  const store = {
    _mem: { current_stage: 0, completed_milestones: [] },
    load() { return this._mem },
    save(m) { this._mem = m },
  }

  const planner = createPlanner({ memoryStore: store, now: () => 1000 })
  // 模拟濒危状态（饥饿极低，触发生存阻塞）
  const starvingSnapshot = normalizeState({
    schema: 'bws.state/1',
    ready: true,
    data: {
      schema: 'bws.state/1',
      observer: { status: 'ok', sequence: 1, snapshot_id: 's1', timestamp: 1000 },
      actor: { valid: true, alive: true, tile_x: 0, tile_z: 0 },
      player: {
        health: { current: 150, max: 150 },
        hunger: { current: 15, max: 150 }, // 饥饿 10%，触发 blocking
        sanity: { current: 200, max: 200 },
        inventory: { items: [] },
      },
      world: { season: 'autumn', day: 1, phase: 'day' },
      quest_guide: {
        installed: true,
        open_tasks: [
          {
            id: 'a1',
            title: '制作火炬',
            mats: [{ icon: 'cutgrass', name: '草', n: 2 }, { icon: 'twigs', name: '树枝', n: 2 }],
            auto: [[{ k: 'craft', p: ['torch'], n: 1 }]],
          },
        ],
        done_tasks: {},
      },
    },
  })

  const plan = planner.plan(starvingSnapshot)
  assert.equal(plan.survival.blocking, true, '应当处于生存阻塞状态')
  assert.ok(plan.board.tasks.some((t) => t.id === 'qg_a1'), '任务手册任务依然应在看板中')
  assert.ok(plan.next.includes('先解决生存'), 'next 应提醒先解决生存')

  const decision = arbitrate(starvingSnapshot, { devPlan: plan, survivalPlan: { title: '急需进食', why: '饥饿极低', next: '吃食物' } })
  const renderedText = renderDecision(decision, plan)
  assert.ok(renderedText.includes('当前主线模式：任务手册自主追踪'), '即便在保命状态下也标明任务手册主线')
  assert.ok(renderedText.includes('安全后继续任务手册任务'), '决策理由标明安全后继续任务手册')
})

test('QG-10: 任务手册遇到生火任务时优先锁定永久火坑 firepit 并自动补充 12 石头 + 2 木头依赖', () => {
  const questGuide = {
    installed: true,
    tracked_task: {
      id: 'a6',
      title: '生一堆火',
      season: 'autumn',
      icon: 'campfire',
      mats: [
        { icon: 'log', name: '木头', n: 2 },
        { icon: 'cutgrass', name: '采下的草', n: 3 },
      ],
      auto: [
        [{ k: 'craft', p: ['campfire', 'firepit'], n: 1 }],
      ],
      done: false,
    },
  }

  // 身上只有 2 块石头，0 木头，3 草
  const snapshot = {
    player: {
      inventory: {
        items: [
          { prefab: 'rocks', count: 2 },
          { prefab: 'cutgrass', count: 3 },
        ],
      },
    },
    nearby: { buckets: { structures: [] } },
  }
  const memory = { known_buildings: [] }

  const tasks = questGuideTasksFor({ questGuide, snapshot, memory, now: 1000 })
  // 必须优先选择 firepit，移除仅营火用的 cutgrass 依赖，并生成 12 石头 (差 10) 和 2 木头 (差 2) 的采集依赖
  const mainTask = tasks.find((t) => t.id === 'qg_a6')
  assert.ok(mainTask, '应生成主任务 qg_a6')
  assert.equal(mainTask.skill_args.recipe, 'firepit', '必须优先锁定 firepit 而不是一次性营火')

  const rocksTask = tasks.find((t) => t.id === 'gather_for_a6_rocks')
  assert.ok(rocksTask, '应生成石头采集任务')
  assert.equal(rocksTask.skill_args.target_items.rocks, 12, '石头目标必须为 12 块')

  const logTask = tasks.find((t) => t.id === 'gather_for_a6_log')
  assert.ok(logTask, '应生成木头采集任务')
  assert.equal(logTask.skill_args.target_items.log, 2, '木头目标必须为 2 块')

  // 不应存在草料依赖任务
  const grassTask = tasks.find((t) => t.id === 'gather_for_a6_cutgrass')
  assert.equal(grassTask, undefined, '锁定 firepit 后不应产生草料采集依赖')

  // 验证 evaluateTarget：地上出现 firepit 后自动判定为完成
  const target = mainTask.target
  const doneSnapshot = {
    quest_guide: { installed: true, done_tasks: {} },
    nearby: {
      buckets: {
        structures: [{ prefab: 'firepit', x: -25, z: 49 }],
      },
    },
  }
  const evalResult = evaluateTarget(target, doneSnapshot, memory)
  assert.equal(evalResult.done, true, '地上已有 firepit 时应判定主任务已完成')
})

test('QG-11: 多配方制作任务（如 a2 先斧头后镐）在斧头完成后自动切换为镐并生成对应材料依赖，mergeBoard 正确解除终态锁存', () => {
  const questGuide = {
    installed: true,
    tracked_task: {
      id: 'a2',
      title: '做斧头和镐',
      season: 'autumn',
      icon: 'axe',
      mats: [
        { icon: 'twigs', name: '树枝', n: 1 },
        { icon: 'flint', name: '燧石', n: 1 },
      ],
      auto: [
        [{ k: 'craft', p: ['axe'], n: 1 }],
        [{ k: 'craft', p: ['pickaxe', 'goldenpickaxe'], n: 1 }],
      ],
      done: false,
    },
  }

  // 场景：玩家身上已有斧头（手持或背包），但没有镐，也没有多余燧石
  const snapshotWithAxe = {
    quest_guide: questGuide,
    player: {
      equipment: { slots: { hands: { prefab: 'axe', count: 1 } } },
      inventory: {
        items: [
          { prefab: 'twigs', count: 4 },
        ],
      },
    },
  }

  const tasks = questGuideTasksFor({ questGuide, snapshot: snapshotWithAxe, now: 1000 })
  // 应当自动锁定 pickaxe，所需材料 twigs: 2 (已有4足够), flint: 2 (缺2个)
  const flintGather = tasks.find((t) => t.id === 'gather_for_a2_flint')
  assert.ok(flintGather, '应生成燧石采集任务')
  assert.equal(flintGather.skill_args.target_items.flint, 2, '采燧石目标数量应补足至 2 个')
  assert.equal(flintGather.target.count, 2)

  const pickaxeTask = tasks.find((t) => t.id === 'qg_a2')
  assert.ok(pickaxeTask, '主任务 qg_a2 应当存在')
  assert.equal(pickaxeTask.skill_args.recipe, 'pickaxe', '待制作配方应当切换为 pickaxe')
  assert.deepEqual(pickaxeTask.depends_on, ['gather_for_a2_flint'], '应当依赖采燧石任务')

  // 验证 mergeBoard：之前已有一张旧看板，其中 qg_a2 和 gather_for_a2_flint 曾因做斧头而被标记为 completed/done
  const prevBoard = {
    schema: BOARD_SCHEMA,
    goal: '旧目标',
    tasks: [
      {
        id: 'gather_for_a2_flint',
        title: '收集燧石（还需 1 个）',
        status: 'completed',
        priority: 1,
        progress: { current: 1, required: 1 },
        target: { type: 'inventory', prefab: 'flint', count: 1 },
      },
      {
        id: 'qg_a2',
        title: '做斧头和镐',
        status: 'completed',
        priority: 2,
        progress: { current: 1, required: 1 },
        target: { type: 'quest_complete', quest_id: 'a2', fallback_prefab: 'axe', count: 1 },
      },
    ],
  }

  const merged = mergeBoard(prevBoard, tasks, { goal: '新目标', now: 1000, snapshot: snapshotWithAxe })
  const mergedFlint = merged.tasks.find((t) => t.id === 'gather_for_a2_flint')
  const mergedMain = merged.tasks.find((t) => t.id === 'qg_a2')

  assert.equal(mergedFlint.status, 'ready', '由于身上燧石不足2个，燧石采集任务应当重置为 ready')
  assert.equal(mergedFlint.target.count, 2)
  assert.equal(mergedMain.status, 'ready', '由于镐尚未制作且任务未打钩，qg_a2 应当重置为 ready')
  assert.equal(mergedMain.skill_args.recipe, 'pickaxe')
})


