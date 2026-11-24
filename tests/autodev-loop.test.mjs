// 自动修复护栏（auditDiff）与迭代决策（evaluateIteration）单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditDiff, evaluateIteration, parseUnifiedDiff, DEFAULT_PROTECTED_FILES } from '../lib/autodev/guardrails.js'

const diff = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`

test('GUARD-1：parseUnifiedDiff 抽到增删行与删除标记', () => {
  const files = parseUnifiedDiff(diff('tests/a.test.mjs', '@@ -1,1 +1,1 @@\n-test("x",()=>{})\n+test("x",()=>{assert.ok(1)})\n'))
  const info = files.get('tests/a.test.mjs')
  assert.ok(info)
  assert.equal(info.removed.length, 1)
  assert.equal(info.added.length, 1)
})

test('GUARD-2：只新增测试（纯 + 行）→ 通过', () => {
  const d = `diff --git a/tests/new.test.mjs b/tests/new.test.mjs\n--- /dev/null\n+++ b/tests/new.test.mjs\n@@ -0,0 +1,2 @@\n+test("ok", () => {})\n+assert.ok(1)\n`
  const r = auditDiff(d)
  assert.equal(r.ok, true)
  assert.deepEqual(r.touchedTests, ['tests/new.test.mjs'])
})

test('GUARD-3：删除断言/测试声明 → 护栏失守', () => {
  const d = diff('tests/a.test.mjs', '@@ -1,3 +1,2 @@\n test("a", () => {\n-  assert.equal(1, 2)\n })\n')
  const r = auditDiff(d)
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.code === 'test_assertions_removed'))
  assert.equal(r.deletedTestLines.length, 1)
})

test('GUARD-4：整份删除测试文件 → 护栏失守', () => {
  const d = `diff --git a/tests/a.test.mjs b/tests/a.test.mjs\ndeleted file mode 100644\n--- a/tests/a.test.mjs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-test("a", () => {})\n-assert.ok(1)\n`
  const r = auditDiff(d)
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.code === 'test_file_deleted'))
})

test('GUARD-5：新增 .skip 凑绿 → 护栏失守', () => {
  const d = diff('tests/a.test.mjs', '@@ -1,1 +1,1 @@\n-test("a", () => {})\n+test.skip("a", () => {})\n')
  const r = auditDiff(d)
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.code === 'test_skipped'))
})

test('GUARD-6：改核心放行文件会被标记 touchedProtected（但本身不算违规）', () => {
  const d = diff('lib/control.js', '@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2\n')
  const r = auditDiff(d)
  assert.equal(r.ok, true)
  assert.ok(r.touchedProtected.includes('lib/control.js'))
  assert.ok(DEFAULT_PROTECTED_FILES.includes('lib/control.js'))
})

test('DECIDE-1：单测红 → fix_unit', () => {
  assert.equal(evaluateIteration({ iter: 1, maxIters: 5, score: 10, bestScore: 100, unitOk: false }).action, 'fix_unit')
})

test('DECIDE-2：护栏失守 → rollback', () => {
  assert.equal(evaluateIteration({ iter: 1, maxIters: 5, score: 100, bestScore: 50, guardrailOk: false }).action, 'rollback')
})

test('DECIDE-3：分数提升 → commit', () => {
  const r = evaluateIteration({ iter: 1, maxIters: 5, score: 100, bestScore: -Infinity })
  assert.equal(r.action, 'commit')
  assert.equal(r.bestScore, 100)
})

test('DECIDE-4：分数下降且未到停滞上限 → rollback', () => {
  assert.equal(evaluateIteration({ iter: 1, maxIters: 5, score: 50, bestScore: 100, stagnantRounds: 0 }).action, 'rollback')
})

test('DECIDE-5：连续无改善达到上限 → stop', () => {
  const r = evaluateIteration({ iter: 2, maxIters: 5, score: 100, bestScore: 100, stagnantRounds: 1, maxStagnant: 2 })
  assert.equal(r.action, 'stop')
})

test('DECIDE-6：分数持平且未到上限 → retry', () => {
  assert.equal(evaluateIteration({ iter: 1, maxIters: 5, score: 100, bestScore: 100, stagnantRounds: 0, maxStagnant: 2 }).action, 'retry')
})

test('DECIDE-7：达到最大轮次且无改善 → stop', () => {
  assert.equal(evaluateIteration({ iter: 5, maxIters: 5, score: 80, bestScore: 100, stagnantRounds: 0 }).action, 'stop')
})
