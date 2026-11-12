// Phase 5 M2 · Bridge 控制权持久化与二次校验测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStateStore, defaultControlState, CONTROL_STATE_VERSION } from '../src/control.js'

function tempPath(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bws-control-'))
  return { dir, path: join(dir, 'control-state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('control：默认 SUPERVISED，无 holder，emergency=false', () => {
  const t = tempPath()
  try {
    const store = new ControlStateStore({ path: t.path })
    const s = store.get()
    assert.equal(s.version, CONTROL_STATE_VERSION)
    assert.equal(s.mode, 'SUPERVISED')
    assert.equal(s.holder, null)
    assert.equal(s.emergency_stop, false)
    assert.equal(s.history.length, 1)
  } finally { t.cleanup() }
})

test('control：update 落盘，重启后能恢复', () => {
  const t = tempPath()
  try {
    const a = new ControlStateStore({ path: t.path })
    a.update({
      mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: 9999999999999,
      emergency_stop: false, reason: 'Agent 申请控制权',
    })
    assert.equal(existsSync(t.path), true)
    const raw = JSON.parse(readFileSync(t.path, 'utf8'))
    assert.equal(raw.holder, 'C1')

    const b = new ControlStateStore({ path: t.path })
    assert.equal(b.get().holder, 'C1', '重启后应恢复')
    assert.equal(b.get().session_id, 'S1')
    assert.equal(b.get().history.length, 2)
  } finally { t.cleanup() }
})

test('control：assertCanExecute 五重校验（紧急>模式>holder>session>lease）', () => {
  const t = tempPath()
  try {
    const store = new ControlStateStore({ path: t.path })
    assert.equal(store.assertCanExecute('C1', 'S1').code, 'CONTROL_NOT_HELD', '无 holder')

    store.update({ mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: 9999999999999, emergency_stop: false, reason: 'x' })
    assert.equal(store.assertCanExecute('C1', 'S1').allowed, true)
    assert.equal(store.assertCanExecute('C2', 'S1').code, 'CONTROL_NOT_HELD', '不是 holder')
    assert.equal(store.assertCanExecute('C1', 'S2').code, 'SESSION_MISMATCH', 'session 不一致')

    store.update({ mode: 'MANUAL', holder: null, session_id: null, lease_expires_at: null, emergency_stop: false, reason: '人工接管' })
    assert.equal(store.assertCanExecute('C1', 'S1').code, 'MANUAL_OVERRIDE')

    store.update({ mode: 'EMERGENCY_STOP', holder: null, session_id: null, lease_expires_at: null, emergency_stop: true, reason: '紧急停止' })
    assert.equal(store.assertCanExecute('C1', 'S1', true).code, 'EMERGENCY_STOP', '紧急停止连只读也拒')
  } finally { t.cleanup() }
})

test('control：lease 过期拒绝；read_only 豁免写权限', () => {
  const t = tempPath()
  let clock = 1000
  try {
    const store = new ControlStateStore({ path: t.path, now: () => clock })
    store.update({ mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: 2000, emergency_stop: false, reason: 'x' })
    assert.equal(store.assertCanExecute('C1', 'S1').allowed, true)
    clock = 3000
    assert.equal(store.assertCanExecute('C1', 'S1').code, 'CONTROL_EXPIRED')
    assert.equal(store.assertCanExecute('anyone', 'S1', true).allowed, true, '只读不需要 holder')
  } finally { t.cleanup() }
})

test('control：history 最多 50 条，不无限增长', () => {
  const t = tempPath()
  try {
    const store = new ControlStateStore({ path: t.path })
    for (let i = 0; i < 60; i += 1) {
      store.update({ mode: 'SUPERVISED', holder: 'C' + i, session_id: 'S1', lease_expires_at: 9999999999999, emergency_stop: false, reason: 'r' + i })
    }
    assert.equal(store.get().history.length, 50)
    assert.match(store.get().history.at(-1)!.reason, /r59/)
  } finally { t.cleanup() }
})

test('control：损坏的落盘文件回退默认值（不让 Bridge 起不来）', () => {
  const t = tempPath()
  try {
    writeFileSync(t.path, '{not json', 'utf8')
    const store = new ControlStateStore({ path: t.path })
    assert.equal(store.get().mode, 'SUPERVISED')
    assert.equal(store.get().holder, null)
  } finally { t.cleanup() }
})

test('control：status() 带 persisted/last_error', () => {
  const t = tempPath()
  try {
    const store = new ControlStateStore({ path: t.path })
    const s = store.status()
    assert.equal(s.persisted, true)
    assert.ok('last_error' in s)
  } finally { t.cleanup() }
})

test('control：defaultControlState 结构完整', () => {
  const s = defaultControlState(123)
  assert.equal(s.updated_at, 123)
  assert.equal(s.mode, 'SUPERVISED')
  assert.ok(Array.isArray(s.history))
})
