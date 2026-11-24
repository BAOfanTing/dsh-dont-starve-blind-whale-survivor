// 自动修复的「护栏」与「迭代决策」——全自动测试闭环第 5、6 步的纯逻辑部分。
//
// 两块职责：
//   1) auditDiff()       —— 对 `git diff` 文本做机械化审计：禁止「删测试 / 跳过测试 / 删测试文件」，
//                          并报出本轮是否碰了核心放行逻辑（guard.lua / control.js / stop-coordinator.js）。
//   2) evaluateIteration() —— 根据「健康分 + 单测是否绿 + 护栏是否过」决定这一轮
//                          commit / rollback / retry / stop，避免 AI 越改越坏、陷入死循环。
//
// 全是纯函数、可单测，不依赖 git 真的存在（主控把 `git diff` 的文本喂进来即可）。

/** 受保护的核心放行/安全边界文件（改动它们必须确保对应专项测试 100% 全绿）。 */
export const DEFAULT_PROTECTED_FILES = [
  'DontStarveWhaleSurvivor/scripts/whale/guard.lua',
  'DontStarveWhaleSurvivor/scripts/whale/guard_specs.lua',
  'lib/control.js',
  'lib/control/stop-coordinator.js',
]

/** 归一化路径分隔符，方便跨平台比较。 */
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * 解析 unified diff，聚合每个文件的增删行。
 * 只关心 +/- 内容行；文件头（diff --git / --- / +++）用来判断文件身份与是否被删除。
 * @returns {Map<string, {added: string[], removed: string[], deleted: boolean}>}
 */
export function parseUnifiedDiff(diffText) {
  const files = new Map()
  const ensure = (f) => {
    if (!files.has(f)) files.set(f, { added: [], removed: [], deleted: false })
    return files.get(f)
  }
  let current = null
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      // diff --git a/x b/x
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/)
      current = m ? norm(m[2]) : null
      if (current) ensure(current)
      continue
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim()
      if (p === '/dev/null') { if (current) ensure(current).deleted = true }
      else {
        const target = norm(p.replace(/^b\//, ''))
        if (!current) { current = target; ensure(current) }
      }
      continue
    }
    if (raw.startsWith('--- ')) continue
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (current) ensure(current).added.push(raw.slice(1))
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      if (current) ensure(current).removed.push(raw.slice(1))
    }
  }
  return files
}

const TEST_DECL_RE = /^\s*(test|it|describe)\s*\(/
const ASSERT_RE = /\bassert(\.\w+)?\s*\(/

/**
 * 审计 diff 是否违反护栏。
 * 违规判定（任一即失守）：
 *   a) 删除了 tests/*.test.mjs 里的测试声明或断言行；
 *   b) 删除了整份 tests/*.test.mjs 文件；
 *   c) 给测试加了 .skip / .todo 来「凑绿」（新增行里出现 test.skip / it.skip / describe.skip）。
 * @returns {{ok:boolean, violations:object[], touchedProtected:string[], touchedTests:string[], deletedTestLines:object[]}}
 */
export function auditDiff(diffText, opts = {}) {
  const protectedFiles = (opts.protectedFiles ?? DEFAULT_PROTECTED_FILES).map(norm)
  const files = parseUnifiedDiff(diffText)
  const violations = []
  const deletedTestLines = []
  const touchedProtected = []
  const touchedTests = []

  for (const [file, info] of files) {
    const isTest = /(^|\/)tests\/.*\.test\.mjs$/.test(file)
    const touched = info.added.length > 0 || info.removed.length > 0 || info.deleted
    if (isTest && touched) touchedTests.push(file)
    if (protectedFiles.includes(file) && touched) touchedProtected.push(file)

    if (!isTest) continue

    if (info.deleted) {
      violations.push({ code: 'test_file_deleted', file, message: `整份测试文件被删除：${file}` })
      continue
    }

    // 删除的测试声明 / 断言行
    const removedBad = info.removed.filter((l) => TEST_DECL_RE.test(l) || ASSERT_RE.test(l))
    if (removedBad.length > 0) {
      deletedTestLines.push({ file, lines: removedBad })
      violations.push({
        code: 'test_assertions_removed',
        file,
        message: `删除/削弱了 ${removedBad.length} 行测试断言：${file}`,
        lines: removedBad.slice(0, 10),
      })
    }

    // 新增 .skip / .todo 凑绿
    const addedSkip = info.added.filter((l) => /\.(skip|todo)\s*\(/.test(l) || /(^|\s)test\.skip\b/.test(l))
    if (addedSkip.length > 0) {
      violations.push({
        code: 'test_skipped',
        file,
        message: `新增了 .skip/.todo，疑似跳过测试凑绿：${file}`,
        lines: addedSkip.slice(0, 10),
      })
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    touchedProtected,
    touchedTests,
    deletedTestLines,
  }
}

/**
 * 迭代决策：给出这一轮该怎么走。
 * 优先级：单测红 → fix_unit；护栏失守 → rollback；分数升 → commit；
 * 分数降/持平且到停滞上限或轮次上限 → stop；分数降 → rollback；持平 → retry。
 *
 * @param {object} input
 * @param {number} input.iter          当前轮次（1 起）
 * @param {number} input.maxIters      最大轮次
 * @param {number} input.score         本轮健康分
 * @param {number} input.bestScore     历史最佳分（无则 -Infinity）
 * @param {boolean} [input.unitOk]     静态+单测是否全绿
 * @param {boolean} [input.guardrailOk] 护栏是否通过
 * @param {number} [input.stagnantRounds] 之前已连续无改善的轮数
 * @param {number} [input.maxStagnant] 允许的最大连续无改善轮数
 */
export function evaluateIteration(input = {}) {
  const {
    iter,
    maxIters,
    score,
    bestScore,
    unitOk = true,
    guardrailOk = true,
    stagnantRounds = 0,
    maxStagnant = 2,
  } = input

  if (!unitOk) {
    return { action: 'fix_unit', reason: '静态检查/单测未通过，先让 AI 修到全绿', stagnantRounds }
  }
  if (!guardrailOk) {
    return { action: 'rollback', reason: '护栏校验失败（疑似删改/跳过测试），回滚', stagnantRounds: stagnantRounds + 1 }
  }

  const improved = Number.isFinite(score) && score > bestScore
  if (improved) {
    return { action: 'commit', reason: `健康分提升 ${fmt(bestScore)}→${score}，记为最佳检查点`, stagnantRounds: 0, bestScore: score }
  }

  const nextStagnant = stagnantRounds + 1
  if (nextStagnant >= maxStagnant || iter >= maxIters) {
    return {
      action: 'stop',
      reason: `连续 ${nextStagnant} 轮无改善或达到最大轮次(${maxIters})，回退到最佳提交并交人工 Review`,
      stagnantRounds: nextStagnant,
      bestScore,
    }
  }
  if (Number.isFinite(score) && score < bestScore) {
    return { action: 'rollback', reason: `健康分下降 ${fmt(bestScore)}→${score}，回滚后重试`, stagnantRounds: nextStagnant, bestScore }
  }
  return { action: 'retry', reason: `健康分持平（${fmt(score)}），重试`, stagnantRounds: nextStagnant, bestScore }
}

function fmt(n) {
  return Number.isFinite(n) ? String(n) : '-'
}
