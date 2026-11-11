import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StateStore, normalizeInventory, normalizeNearby, normalizeState, tickOf } from '../src/store.js'
import type { WireRecord } from '../src/record.js'

const header = (type: string, tick?: number) => ({
  schema_version: '1',
  type,
  phase: 1,
  observer_version: '0.3.0',
  side: 'server',
  shard: 'master',
  session: 'S1',
  t: 1794410000,
  rt: 10,
  sim_tick: 600,
  ...(tick === undefined ? {} : { tick }),
})

const stateRecord = (tick: number, extra: Partial<WireRecord> = {}): WireRecord =>
  ({
    ...header('state', tick),
    player: { valid: true, prefab: 'willow', position: { x: 1, z: 2, tile_x: 0, tile_z: 0 } },
    inventory: { slots: 15, used: 1, items: [{ prefab: 'lighter', name: '薇洛的打火机', count: 1, fuel: 96.7 }] },
    world: { cycles: 1, day: 2, phase: 'day', season: 'autumn' },
    observer: { interval: 2, tick, errors: 0, players: { count: 1 } },
    ...extra,
  }) as WireRecord

const nearbyRecord = (tick: number): WireRecord =>
  ({
    ...header('nearby', tick),
    radius_tiles: 16,
    scanned: 20,
    returned: 1,
    truncated: false,
    scanned_at_tick: tick,
    counts: { tree: 1 },
    entities: [{ prefab: 'evergreen', name: '常青树', category: 'tree', tile_x: 3, tile_z: 4, distance: 1.5, work_left: 10 }],
  }) as WireRecord

const bootRecord = (): WireRecord =>
  ({ ...header('boot'), mod: 'BlindWhaleSurvivor', ismastersim: true, interval: 2, players: { count: 1 } }) as WireRecord

test('tick 归一化：顶层优先，老格式退回 observer.tick', () => {
  assert.equal(tickOf({ type: 'state', tick: 5 } as unknown as WireRecord), 5)
  const legacy = { type: 'state', observer: { tick: 9 } } as unknown as WireRecord
  assert.equal(tickOf(legacy), 9)
  assert.equal(tickOf({ type: 'state' } as unknown as WireRecord), undefined)
})

test('空表归一化：items / entities 转成数组', () => {
  const legacyItems = normalizeState({ ...header('state', 1), inventory: { slots: 15, used: 0, items: {} } } as WireRecord)
  assert.deepEqual(legacyItems?.inventory?.items, [])

  const legacyEntities = normalizeNearby({ ...header('nearby', 1), radius_tiles: 16, entities: {} } as WireRecord)
  assert.deepEqual(legacyEntities?.entities, [])

  const inventory = normalizeInventory({ slots: 15, used: 1, items: [{ prefab: 'axe', count: 2 }], equipment: { hands: { prefab: 'axe', count: 1 } } })
  assert.equal(inventory?.items[0]?.count, 2)
  assert.equal((inventory?.equipment as Record<string, { prefab: string }>).hands?.prefab, 'axe')
})

test('状态合并：state + 同 tick 的 nearby', () => {
  const store = new StateStore({ maxTickGap: 3 })
  assert.equal(store.apply(stateRecord(5)), 'state')
  assert.equal(store.apply(nearbyRecord(5)), 'nearby')

  const state = store.state()
  assert.ok(state)
  assert.equal(state?.tick, 5)
  assert.equal(state?.nearby?.entities.length, 1)
  assert.equal(state?.nearby_tick, 5)
  assert.equal(state?.nearby_stale, false)
  assert.equal(state?.timestamp.unix, 1794410000)
})

test('nearby 落后几个周期仍可配对，但标 nearby_stale；差太多就不带', () => {
  const store = new StateStore({ maxTickGap: 3 })
  store.apply(stateRecord(9))
  store.apply(nearbyRecord(8))
  assert.equal(store.state()?.nearby_stale, true, '差 1 个周期算旧但可用')

  const store2 = new StateStore({ maxTickGap: 1 })
  store2.apply(stateRecord(9))
  store2.apply(nearbyRecord(3))
  assert.equal(store2.state()?.nearby, undefined, '差太多就宁可不给')
})

test('客户端记录不采信；重复记录被去重', () => {
  const store = new StateStore({ maxTickGap: 3 })
  const clientRecord = { ...stateRecord(1), side: 'client' } as WireRecord
  assert.equal(store.apply(clientRecord), 'ignored')

  assert.equal(store.apply(stateRecord(2)), 'state')
  assert.equal(store.apply(stateRecord(2)), 'ignored')
  const status = store.status()
  assert.equal(status.counts.state, 1)
  assert.equal(status.counts.duplicates, 1)
  assert.equal(status.counts.ignored, 1)
})

test('新 boot = 游戏重开：清快照、记一次 restart', () => {
  const store = new StateStore({ maxTickGap: 3 })
  store.apply(bootRecord())
  store.apply(stateRecord(1))
  assert.ok(store.state())

  store.apply(bootRecord())
  assert.equal(store.state(), null, 'boot 之后旧的快照要清掉')
  assert.equal(store.status().restarts, 1)

  store.apply(stateRecord(1))
  assert.ok(store.state(), '新一次的 state 能重新建立快照')
})

test('schema 校验失败的记录不进快照，但会被计数', () => {
  const store = new StateStore({ maxTickGap: 3 })
  assert.equal(store.apply(stateRecord(1), ['/observer must be object']), 'ignored')
  assert.equal(store.state(), null)
  assert.equal(store.status().counts.invalid, 1)
  assert.ok(store.status().invalidSamples[0]?.errors.length)
})

test('status 反映连接情况：没数据 / 有数据但过期', () => {
  let clock = 1000
  const store = new StateStore({ maxTickGap: 3, now: () => clock })
  const cold = store.status(15000)
  assert.equal(cold.connected, false)
  assert.match(String(cold.reason), /还没收到/)

  clock = 2000
  store.apply(stateRecord(1))
  assert.equal(store.status(15000).connected, true)

  clock = 1000 + 60000
  const stale = store.status(15000)
  assert.equal(stale.connected, false)
  assert.match(String(stale.reason), /秒前/)
})

test('两个分片都在发状态：优先给有玩家的那个（Caves 空着不顶掉主世界）', () => {
  const store = new StateStore({ maxTickGap: 3 })
  const masterState = { ...stateRecord(8), session: 'S_MASTER', shard: 'master' } as WireRecord
  const cavesState = {
    ...stateRecord(9),
    session: 'S_CAVES',
    shard: 'caves',
    player: { valid: false },
  } as WireRecord

  store.apply(masterState)
  store.apply(cavesState)

  const snapshot = store.state()
  assert.equal(snapshot?.session, 'S_MASTER', '虽然 caves 更新，但它没有玩家，应该给 master')
  assert.equal(snapshot?.shard, 'master')

  const status = store.status()
  assert.equal(status.shards.length, 2, 'statu 里应该列出两个分片')
  const caves = status.shards.find((s) => s.session === 'S_CAVES')
  assert.equal(caves?.hasPlayer, false)
  const master = status.shards.find((s) => s.session === 'S_MASTER')
  assert.equal(master?.hasPlayer, true)
})
