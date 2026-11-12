import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSchemaPath } from '../src/config.js'
import { RECORD_PREFIX, createValidator, extractRecord, validateRecord } from '../src/record.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = resolveSchemaPath()

const bootLine =
  '[00:00:27]: [BWS] {"schema_version":"1","type":"boot","phase":1,"observer_version":"0.3.0","side":"server","shard":"master","session":"S1","t":1794410000,"rt":1.5,"sim_tick":60,"mod":"BlindWhaleSurvivor","ismastersim":true,"interval":2,"players":{"count":1}}'

test('extractRecord：从带时间戳前缀的日志行里取出记录', () => {
  const parsed = extractRecord(bootLine)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.record.type, 'boot')
  assert.equal(parsed.record.session, 'S1')
  assert.equal(parsed.record.schema_version, '1')
})

test('extractRecord：行尾 \\r 也能处理', () => {
  const parsed = extractRecord(bootLine + '\r')
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.record.type, 'boot')
})

test('extractRecord：没有标记 / 坏 JSON 分别给出原因', () => {
  const none = extractRecord('[00:00:01]: 其它模组的输出')
  assert.equal(none.ok, false)
  if (!none.ok) assert.equal(none.reason, 'no_marker')

  const bad = extractRecord(`${RECORD_PREFIX}{"type":"state",`)
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.reason, 'bad_json')

  const notObject = extractRecord(`${RECORD_PREFIX}[1,2,3]`)
  assert.equal(notObject.ok, false)
})

test('schema 校验：合规记录通过，缺字段的记录被拒并给出原因', () => {
  const validate = createValidator(SCHEMA)
  const good = extractRecord(bootLine)
  assert.equal(good.ok, true)
  if (good.ok) {
    const checked = validateRecord(validate, good.record)
    assert.equal(checked.errors, undefined)
  }

  const broken = { schema_version: '1', type: 'state', phase: 1, observer_version: '0.3.0', side: 'server', shard: 'master' }
  const rejected = validateRecord(validate, broken as never)
  assert.ok(rejected.errors && rejected.errors.length > 0, '缺 observer 应该被拒')
})
