import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import { loadConfig, resolveSchemaPath } from '../src/config.js'
import { createBridgeServer } from '../src/server.js'
import { StateStore } from '../src/store.js'
import type { LogTailer, TailerFileStatus } from '../src/logTailer.js'
import type { WireRecord } from '../src/record.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = resolveSchemaPath()

function fakeTailer(files: TailerFileStatus[] = []): LogTailer {
  return { status: () => files } as unknown as LogTailer
}

const baseHeader = {
  schema_version: '1',
  phase: 1,
  observer_version: '0.3.0',
  side: 'server',
  shard: 'master',
  session: 'S1',
  t: 1794410000,
  rt: 10,
  sim_tick: 600,
}

const stateRecord = (tick: number): WireRecord =>
  ({
    ...baseHeader,
    type: 'state',
    tick,
    player: {
      valid: true,
      prefab: 'willow',
      name: '薇洛',
      position: { x: 13.8, y: 0, z: -56.5, tile_x: 3, tile_z: -15 },
      health: { current: 150, max: 150, percent: 100, dead: false },
      hunger: { current: 64.5, max: 150, percent: 43 },
    },
    inventory: { slots: 15, used: 1, is_full: false, items: [{ prefab: 'lighter', name: '薇洛的打火机', count: 1, fuel: 96.7 }], equipment: { hands: { prefab: 'lighter', count: 1, fuel: 96.7 } } },
    world: { cycles: 1, day: 2, phase: 'day', season: 'autumn', temperature: 29.5 },
    observer: { interval: 2, tick, errors: 0, players: { count: 1 } },
  }) as WireRecord

const nearbyRecord = (tick: number): WireRecord =>
  ({
    ...baseHeader,
    type: 'nearby',
    tick,
    radius_tiles: 16,
    scanned: 30,
    returned: 2,
    truncated: false,
    scanned_at_tick: tick,
    counts: { tree: 1, item: 1 },
    entities: [
      { prefab: 'evergreen', name: '常青树', category: 'tree', tile_x: 3, tile_z: -14, distance: 1.2, work_left: 10 },
      { prefab: 'log', name: '木头', category: 'item', tile_x: 4, tile_z: -17, distance: 1.8 },
    ],
  }) as WireRecord

async function startServer(store: StateStore) {
  const config = loadConfig({ BWS_LOG_DIR: 'C:/fake', BWS_PORT: '0' })
  const server = createBridgeServer({ config, store, tailer: fakeTailer([{ name: 'master_server_log.txt', path: 'x', missing: false, size: 10, offset: 10, pendingBytes: 0, lines: 5, records: 5, parseFails: 0, rotations: 0, lastRecordAt: Date.now() }]), version: 'test' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}` }
}

test('没有数据时：/health 正常，其余接口 503 并说明原因', async () => {
  const store = new StateStore({ maxTickGap: 3 })
  const { server, base } = await startServer(store)
  try {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    const healthBody = (await health.json()) as Record<string, unknown>
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.connected, false)

    for (const path of ['/api/game/state', '/api/game/player', '/api/game/inventory', '/api/game/world', '/api/game/nearby']) {
      const res = await fetch(`${base}${path}`)
      assert.equal(res.status, 503, `${path} 在没有快照时应该 503`)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal(body.ok, false)
      assert.ok(String(body.reason ?? '').length > 0)
    }

    const missing = await fetch(`${base}/api/nope`)
    assert.equal(missing.status, 404)
  } finally {
    server.close()
  }
})

test('有数据时：7 个接口都返回对应内容，且 /api/game/state 符合 schema', async () => {
  const store = new StateStore({ maxTickGap: 3 })
  store.apply(stateRecord(5))
  store.apply(nearbyRecord(5))
  const { server, base } = await startServer(store)
  try {
    const stateRes = await fetch(`${base}/api/game/state`)
    assert.equal(stateRes.status, 200)
    const stateBody = (await stateRes.json()) as { ok: boolean; state: Record<string, unknown> }
    assert.equal(stateBody.ok, true)
    assert.equal(stateBody.state.tick, 5)

    // 用 schema 的 GameState 定义校验这个响应
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))
    const ajv = new Ajv({ strict: false, allErrors: true })
    const validate = ajv.compile({ $ref: '#/$defs/GameState', $defs: schema.$defs })
    assert.ok(validate(stateBody.state), '响应不符合 GameState schema：' + JSON.stringify(validate.errors))

    const player = (await (await fetch(`${base}/api/game/player`)).json()) as Record<string, unknown>
    assert.equal((player.player as Record<string, unknown>).prefab, 'willow')

    const inventory = (await (await fetch(`${base}/api/game/inventory`)).json()) as Record<string, unknown>
    const inv = inventory.inventory as { items: unknown[] }
    assert.equal(inv.items.length, 1)

    const world = (await (await fetch(`${base}/api/game/world`)).json()) as Record<string, unknown>
    assert.equal((world.world as Record<string, unknown>).day, 2)

    const nearby = (await (await fetch(`${base}/api/game/nearby`)).json()) as Record<string, unknown>
    const near = nearby.nearby as { entities: unknown[] }
    assert.equal(near.entities.length, 2)

    const status = (await (await fetch(`${base}/api/game/status`)).json()) as Record<string, unknown>
    assert.equal(status.connected, true)
    assert.equal(status.session, 'S1')
    assert.equal((status.counts as Record<string, number>).state, 1)
  } finally {
    server.close()
  }
})

test('只接受 GET；其它方法 405', async () => {
  const store = new StateStore({ maxTickGap: 3 })
  const { server, base } = await startServer(store)
  try {
    const res = await fetch(`${base}/health`, { method: 'POST' })
    assert.equal(res.status, 405)
  } finally {
    server.close()
  }
})
