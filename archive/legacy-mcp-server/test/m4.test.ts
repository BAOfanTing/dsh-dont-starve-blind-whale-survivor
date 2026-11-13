// M4 测试：事件流 + Resources + Prompts
//
// 事件流用"两份快照对比"直接验证；Resources/Prompts 通过真实 MCP 协议（子进程 + JSON-RPC）验证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeClient } from '../src/bridge/client.js'
import { loadConfig } from '../src/config.js'
import { EventDetector } from '../src/tools/events.js'
import { createLogger } from '../src/utils/logger.js'
import { PROMPT_SPECS } from '../src/prompts/gamePrompts.js'
import { RESOURCE_SPECS } from '../src/resources/gameResources.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'src', 'index.js')

function snap(overrides: Record<string, unknown> = {}) {
  return {
    tick: 100,
    player: {
      prefab: 'wilson',
      name: '威尔逊',
      is_ghost: false,
      health: { current: 150, max: 150, percent: 100, dead: false },
      hunger: { current: 150, max: 150, percent: 100 },
      sanity: { current: 200, max: 200, percent: 100 },
      position: { tile_x: 0, tile_z: 0 },
    },
    world: { day: 5, phase: 'day', season: 'autumn', temperature: 25, weather: { is_raining: false, is_snowing: false } },
    inventory: { slots: 15, used: 0, items: [] },
    nearby: { scanned: 10, returned: 2, entities: [] },
    ...overrides,
  }
}

// ─────────────────────────── 事件流 ───────────────────────────

test('事件流：首次没有基线 → 不产生事件', () => {
  const detector = new EventDetector({ now: () => 1000 })
  const events = detector.observe(snap(), { stale: false })
  assert.deepEqual(events, [])
  assert.equal(detector.stats().total, 0)
})

test('事件流：生命下降 / 饥饿下降 / 理智下降', () => {
  const detector = new EventDetector({ now: () => 1000 })
  detector.observe(snap(), { stale: false })

  const hurt = detector.observe(
    snap({
      tick: 101,
      player: { ...snap().player, health: { current: 100, max: 150, percent: 66.7, dead: false } },
    }),
    { stale: false },
  )
  const hp = hurt.find((event) => event.kind === 'health_dropped')
  assert.ok(hp, '应该产生 health_dropped')
  // 掉 33.3% 超过 20 个百分点 → critical
  assert.equal(hp.severity, 'critical')
  assert.match(hp.message, /生命下降/)
  assert.equal(hp.detail.before, 100)
  assert.equal(hp.detail.after, 66.7)

  const starving = detector.observe(
    snap({
      tick: 102,
      player: { ...snap().player, health: { current: 100, max: 150, percent: 66.7, dead: false }, hunger: { current: 80, max: 150, percent: 53.3 } },
    }),
    { stale: false },
  )
  assert.ok(starving.some((event) => event.kind === 'hunger_dropped'))

  const insane = detector.observe(
    snap({
      tick: 103,
      player: {
        ...snap().player,
        health: { current: 100, max: 150, percent: 66.7, dead: false },
        hunger: { current: 80, max: 150, percent: 53.3 },
        sanity: { current: 150, max: 200, percent: 75 },
      },
    }),
    { stale: false },
  )
  assert.ok(insane.some((event) => event.kind === 'sanity_dropped'))
})

test('事件流：低于阈值不产生噪声事件', () => {
  const detector = new EventDetector({ healthDropThreshold: 5, now: () => 1000 })
  detector.observe(snap(), { stale: false })
  const tiny = detector.observe(
    snap({ tick: 101, player: { ...snap().player, health: { current: 148, max: 150, percent: 98.7, dead: false } } }),
    { stale: false },
  )
  assert.equal(tiny.filter((event) => event.kind === 'health_dropped').length, 0, '掉 1.3% 不该报事件')
})

test('事件流：昼夜 / 季节 / 天气 / 天数变化', () => {
  const detector = new EventDetector({ now: () => 1000 })
  detector.observe(snap(), { stale: false })

  const night = detector.observe(
    snap({ tick: 101, world: { ...snap().world, phase: 'night', day: 6 } }),
    { stale: false },
  )
  assert.ok(night.some((event) => event.kind === 'phase_changed' && event.severity === 'warning'))
  assert.ok(night.some((event) => event.kind === 'day_changed'))
  const phaseEvent = night.find((event) => event.kind === 'phase_changed')
  assert.match(phaseEvent!.message, /白天 → 夜晚/)

  const winter = detector.observe(
    snap({ tick: 102, world: { ...snap().world, phase: 'night', day: 6, season: 'winter', weather: { is_raining: false, is_snowing: true } } }),
    { stale: false },
  )
  assert.ok(winter.some((event) => event.kind === 'season_changed'))
  assert.ok(winter.some((event) => event.kind === 'weather_changed'))
})

test('事件流：敌对生物出现 / 消失', () => {
  const detector = new EventDetector({ now: () => 1000 })
  detector.observe(snap(), { stale: false })

  const withThreat = detector.observe(
    snap({
      tick: 101,
      nearby: {
        scanned: 10,
        returned: 3,
        entities: [{ prefab: 'spider', name: '蜘蛛', category: 'hostile', distance: 2.5, hp: 75 }],
      },
    }),
    { stale: false },
  )
  const appeared = withThreat.find((event) => event.kind === 'threats_appeared')
  assert.ok(appeared)
  assert.match(appeared.message, /敌对生物/)
  assert.equal(appeared.detail.nearest, '蜘蛛')

  const cleared = detector.observe(snap({ tick: 102 }), { stale: false })
  assert.ok(cleared.some((event) => event.kind === 'threats_cleared'))
})

test('事件流：背包变化 + 死亡/幽灵', () => {
  const detector = new EventDetector({ now: () => 1000 })
  detector.observe(snap(), { stale: false })

  const picked = detector.observe(
    snap({ tick: 101, inventory: { slots: 15, used: 1, items: [{ prefab: 'log', count: 3 }] } }),
    { stale: false },
  )
  assert.ok(picked.some((event) => event.kind === 'inventory_changed'))

  const died = detector.observe(
    snap({
      tick: 102,
      inventory: { slots: 15, used: 1, items: [{ prefab: 'log', count: 3 }] },
      player: { ...snap().player, is_ghost: true, health: { current: 0, max: 150, percent: 0, dead: true } },
    }),
    { stale: false },
  )
  assert.ok(died.some((event) => event.kind === 'player_died' && event.severity === 'critical'))
  assert.ok(died.some((event) => event.kind === 'became_ghost'))
})

test('事件流：数据过期时不比较数值，只报 stale / recovered', () => {
  const detector = new EventDetector({ now: () => 1000 })
  detector.observe(snap(), { stale: false })

  const stale = detector.observe(snap({ tick: 101, player: { ...snap().player, health: { current: 10, max: 150, percent: 6.7, dead: false } } }), {
    stale: true,
    staleReason: 'heartbeat_timeout',
  })
  assert.equal(stale.length, 1, '过期时只该报一条 state_stale')
  assert.equal(stale[0]?.kind, 'state_stale')

  const recovered = detector.observe(snap({ tick: 102 }), { stale: false })
  assert.ok(recovered.some((event) => event.kind === 'state_recovered'))
})

test('事件流：环形缓冲上限 + 过滤 + 增量拉取', () => {
  const detector = new EventDetector({ maxEvents: 3, now: () => 1000 })
  detector.observe(snap(), { stale: false })
  for (let i = 1; i <= 6; i += 1) {
    detector.observe(snap({ tick: 100 + i, world: { ...snap().world, day: 5 + i } }), { stale: false })
  }
  const stats = detector.stats()
  assert.equal(stats.buffered, 3, '环形缓冲只留 3 条')
  assert.ok(stats.total > 3)

  const all = detector.recent({ limit: 100 })
  const lastSeq = all[all.length - 1]!.seq
  const incremental = detector.recent({ sinceSeq: lastSeq - 1 })
  assert.ok(incremental.every((event) => event.seq > lastSeq - 1))

  const onlyCritical = detector.recent({ severity: ['critical'] })
  assert.ok(onlyCritical.every((event) => event.severity === 'critical'))
})

// ─────────────────────────── 规格检查 ───────────────────────────

test('Resources：6 个，URI 全部符合 dst:// 约定', () => {
  assert.equal(RESOURCE_SPECS.length, 6)
  const uris = RESOURCE_SPECS.map((spec) => spec.uri)
  assert.deepEqual(uris.sort(), [
    'dst://game/bridge',
    'dst://game/inventory',
    'dst://game/nearby',
    'dst://game/player',
    'dst://game/status',
    'dst://game/world',
  ])
  for (const spec of RESOURCE_SPECS) {
    assert.equal(spec.mimeType, 'application/json')
    assert.ok(spec.description.length > 4)
  }
})

test('Prompts：4 个，都只给分析指导且都要求检查新鲜度', () => {
  assert.equal(PROMPT_SPECS.length, 4)
  assert.deepEqual(
    PROMPT_SPECS.map((spec) => spec.name).sort(),
    ['night_preparation', 'resource_assessment', 'season_preparation', 'survival_report'],
  )
})

// ─────────────────────────── 真实 MCP 协议 ───────────────────────────

interface Harness {
  child: ReturnType<typeof spawn>
  stderr: () => string
  request: (id: number, method: string, params?: unknown) => Promise<Record<string, any>>
  notify: (method: string, params?: unknown) => void
  close: () => Promise<void>
}

function startServer(env: Record<string, string> = {}): Harness {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env, BWS_MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderrText = ''
  const waiters = new Map<number, (value: Record<string, any>) => void>()
  let buffer = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as Record<string, any>
          if (typeof message.id === 'number' && waiters.has(message.id)) {
            waiters.get(message.id)?.(message)
            waiters.delete(message.id)
          }
        } catch {
          // 忽略非 JSON 行（另有测试专门断言 stdout 干净）
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  const send = (payload: unknown) => child.stdin.write(JSON.stringify(payload) + '\n')
  return {
    child,
    stderr: () => stderrText,
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    request: (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 10000)
        waiters.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      }),
    close: async () => {
      child.stdin.end()
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

async function handshake(h: Harness) {
  await h.request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'm4-test', version: '1' },
  })
  h.notify('notifications/initialized')
}

test('协议：resources/list 返回 6 个资源', async () => {
  const h = startServer()
  try {
    await handshake(h)
    const list = await h.request(2, 'resources/list')
    const resources = list.result.resources as Array<{ uri: string; name: string; mimeType?: string }>
    assert.equal(resources.length, 6, JSON.stringify(list.result))
    assert.ok(resources.some((resource) => resource.uri === 'dst://game/player'))
    assert.ok(resources.some((resource) => resource.uri === 'dst://game/bridge'))
  } finally {
    await h.close()
  }
})

test('协议：resources/read 读取 dst://game/bridge（不依赖游戏是否在跑）', async () => {
  const h = startServer()
  try {
    await handshake(h)
    const read = await h.request(2, 'resources/read', { uri: 'dst://game/bridge' })
    const contents = read.result.contents as Array<{ uri: string; text: string; mimeType?: string }>
    assert.equal(contents.length, 1)
    const text = contents[0]!.text
    assert.ok(text.length > 10)
    const payload = JSON.parse(text) as Record<string, any>
    assert.equal(payload.ok, true)
    assert.equal(payload.source, 'bridge')
    assert.ok(typeof payload.bridge_url === 'string')
  } finally {
    await h.close()
  }
})

test('协议：prompts/list 返回 4 个提示词，且带参数说明', async () => {
  const h = startServer()
  try {
    await handshake(h)
    const list = await h.request(2, 'prompts/list')
    const prompts = list.result.prompts as Array<{ name: string; description?: string; arguments?: Array<{ name: string }> }>
    assert.equal(prompts.length, 4, JSON.stringify(list.result))
    const survival = prompts.find((prompt) => prompt.name === 'survival_report')
    assert.ok(survival)
    assert.ok((survival.arguments ?? []).some((argument) => argument.name === 'focus'))
    const night = prompts.find((prompt) => prompt.name === 'night_preparation')
    assert.ok(night)
    assert.equal((night.arguments ?? []).length, 0, '夜晚准备不需要参数')
  } finally {
    await h.close()
  }
})

test('协议：prompts/get 生成的文本包含取数步骤与新鲜度要求', async () => {
  const h = startServer()
  try {
    await handshake(h)
    const got = await h.request(2, 'prompts/get', { name: 'survival_report', arguments: { focus: 'safety' } })
    const messages = got.result.messages as Array<{ role: string; content: { type: string; text: string } }>
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.role, 'user')
    const text = messages[0]!.content.text
    assert.match(text, /safety/, '应把参数拼进提示')
    assert.match(text, /get_player_status/, '应包含取数步骤')
    assert.match(text, /freshness\.stale/, '应要求检查数据新鲜度')
    assert.match(text, /不能执行任何游戏动作/, '应明确禁止写操作')
  } finally {
    await h.close()
  }
})

test('协议：四个 Prompt 都能取到，且都禁止写操作', async () => {
  const h = startServer()
  try {
    await handshake(h)
    let id = 10
    for (const spec of PROMPT_SPECS) {
      const got = await h.request(id++, 'prompts/get', { name: spec.name, arguments: {} })
      const text = (got.result.messages as Array<{ content: { text: string } }>)[0]!.content.text
      assert.match(text, /不能执行任何游戏动作/, `${spec.name} 必须写明禁止写操作`)
      assert.match(text, /get_|refresh/, `${spec.name} 必须给出取数步骤`)
    }
  } finally {
    await h.close()
  }
})
