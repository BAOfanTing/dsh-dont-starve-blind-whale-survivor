// 从一行游戏日志里取出 [BWS] 记录，并按 schema 校验
//
// 日志行长这样（引擎会在前面加时间戳）：
//   [00:12:34]: [BWS] {"schema_version":"1","type":"state",...}
//
// 注意：饥荒日志每行约 3.9K 字符会截断，所以「解析失败」是很正常的情况，
// 必须当成可统计的事件处理，不能当成致命错误。

import { readFileSync } from 'node:fs'
import { Ajv, type ValidateFunction } from 'ajv'

export const RECORD_PREFIX = '[BWS] '

export type WireRecord = Record<string, unknown> & {
  type: 'boot' | 'state' | 'nearby'
  schema_version: string
  side?: string
  shard?: string
  session?: string
}

export interface ExtractOk {
  ok: true
  record: WireRecord
}
export interface ExtractFail {
  ok: false
  reason: 'no_marker' | 'empty' | 'bad_json'
  detail?: string
}

/** 从一行日志里抽记录（不含 schema 校验） */
export function extractRecord(line: string): ExtractOk | ExtractFail {
  const at = line.indexOf(RECORD_PREFIX)
  if (at < 0) return { ok: false, reason: 'no_marker' }
  let json = line.slice(at + RECORD_PREFIX.length).trim()
  // 有些日志行尾会带 \r
  if (json.endsWith('\r')) json = json.slice(0, -1)
  if (!json) return { ok: false, reason: 'empty' }
  try {
    const value = JSON.parse(json)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'bad_json', detail: 'not_an_object' }
    }
    return { ok: true, record: value as WireRecord }
  } catch (error) {
    return { ok: false, reason: 'bad_json', detail: String((error as Error).message ?? error) }
  }
}

/** 用 schema 编出一个校验器（一份 schema 里用 oneOf 描述 boot/state/nearby） */
export function createValidator(schemaPath: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv({ strict: false, allErrors: true })
  return ajv.compile(schema)
}

export interface ValidatedRecord {
  record: WireRecord
  errors?: string[]
}

/** 校验一条记录；不合格时返回可读的错误列表（给 /health 和日志用） */
export function validateRecord(validate: ValidateFunction, record: WireRecord): ValidatedRecord {
  if (validate(record)) return { record }
  const errors = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`)
  return { record, errors }
}
