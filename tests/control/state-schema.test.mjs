// 状态契约校验：用 ajv 校验真实 Lua observe.lua 输出与 normalizeState() 归一化快照是否符合 schema/state.schema.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'

import { normalizeState } from '../../lib/state/snapshot.js'
import { loadTargets, ents } from '../helpers/target-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'state.schema.json'), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
const validateAny = ajv.compile(schema)
const validateNormalized = ajv.compile({ ...schema, $id: `${schema.$id}#normalized`, oneOf: undefined, $ref: '#/$defs/NormalizedState' })
const validateWire = ajv.compile({ ...schema, $id: `${schema.$id}#wire`, oneOf: undefined, $ref: '#/$defs/WireEnvelope' })

test('STATE-SCHEMA-1：真实 Lua observe.lua 产物与 normalizeState 归一化快照均通过 schema/state.schema.json 校验', async () => {
  const env = await loadTargets({
    entities: [
      ents.flint({ x: 4, z: 0 }),
      ents.tree({ x: 8, z: 4 }),
      ents.berrybush({ x: -4, z: 4 }),
    ],
  })
  env.run(`
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.BuildSample(actor, { seq = 7, now = 1005 })
    local envelope = {
      v = 1,
      seq = 7,
      t = 1794500000,
      mod = "0.41.3",
      build = "0.41.3",
      ready = data.ready == true,
      text = text,
      data = data,
    }
    OUT_JSON = Whale.json.encode(envelope)
  `)
  const rawEnvelope = JSON.parse(env.get('OUT_JSON'))
  assert.equal(validateWire(rawEnvelope), true, `WireEnvelope 校验失败: ${ajv.errorsText(validateWire.errors)}`)
  assert.equal(validateAny(rawEnvelope), true, `根 schema 应兼容 WireEnvelope: ${ajv.errorsText(validateAny.errors)}`)

  const normalized = normalizeState(rawEnvelope, { ageMs: 250, now: 1794500001000, path: 'whale_state.json' })
  assert.equal(normalized.schema, 'bws.state/1')
  assert.equal(normalized.ok, true)
  assert.equal(validateNormalized(normalized), true, `NormalizedState 校验失败: ${ajv.errorsText(validateNormalized.errors)}`)
  assert.equal(validateAny(normalized), true, `根 schema 应兼容 NormalizedState: ${ajv.errorsText(validateAny.errors)}`)
})

test('STATE-SCHEMA-2：缺失角色（no_actor）与危险区/角色信息结构同样满足契约，非法契约被拒绝', () => {
  const noActorRaw = {
    v: 1,
    seq: 1,
    t: 1794500000,
    mod: '0.41.3',
    build: '0.41.3',
    ready: false,
    text: '# 状态快照序列号 s1 · 状态 no_actor',
    data: {
      schema: 'bws.state/1',
      ready: false,
      identity: {
        session_id: 's1',
        cluster_id: 'c1',
        cluster_id_source: 'the_net',
        shard_id: '1',
        world_key: 'cluster:c1/shard:1',
        world_key_source: 'cluster_id',
      },
      actor: null,
      player: null,
      world: { status: 'ok', day: 1, phase: 'day', season: 'autumn' },
      nearby: null,
      warnings: [],
      observer: {
        snapshot_id: 's1',
        sequence: 1,
        timestamp: 1000,
        sampled_at: 1000,
        sample_age_ms: 0,
        reused: false,
        status: 'no_actor',
        errors: ['no_player'],
        unavailable_fields: [],
        schema: 'bws.state/1',
      },
    },
  }
  const normalized = normalizeState(noActorRaw, { ageMs: 100, now: 1794500000100 })
  assert.equal(normalized.ok, false)
  assert.equal(normalized.status, 'no_actor')
  assert.equal(validateNormalized(normalized), true, `no_actor 校验失败: ${ajv.errorsText(validateNormalized.errors)}`)

  assert.equal(validateAny({ schema: 'legacy', ok: false }), false, '废弃或残缺结构必须被拒绝')
})
