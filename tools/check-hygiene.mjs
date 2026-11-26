#!/usr/bin/env node
// 仓库卫生与架构一致性门禁：
//   1) 活代码/活脚本/活文档禁止残留阶段编号、工单号或日期排错日记；
//   2) README.md 与 docs/*.md 的相对 Markdown 链接必须指向存在的文件；
//   3) 根目录只允许保留 package-lock.json，禁止多包管理器锁文件冲突；
//   4) tests/**/*.test.mjs 禁止以历史阶段编号命名。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walkFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, exts, out)
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

// 用拼接方式构造敏感词模式，避免本检查脚本在扫描自身时误触发。
const PHASE_WORD_RE = new RegExp(
  '\\b(?:' +
    [
      'M[012](?:\\.[0-9]+)*',
      'SURVIVAL-[A-Z0-9.-]+',
      'OBSERVATION-[A-Z0-9.-]+',
      'TARGET' + '-REFRESH',
      'NATIVE' + '[-_]REUSE',
      'TE' + 'NT',
      'Phase\\s+[GR][0-9.]*',
      'PHASE-[GR][0-9.]*',
      'R8\\.[0-9.]+',
      'R7[0-9]|R8[0-9]',
      'ISSUE-[0-9A-Za-z-]+',
      'P[012]-[0-9A-Za-z-]+',
      '2026-(?:1[0-2])-[0-9]{2}',
      '202[7-9]-(?:0[1-9]|1[0-2])-[0-9]{2}',
    ].join('|') +
    ')\\b',
)

const LEGACY_LITERAL_RE = new RegExp(
  [
    'STATUS' + '\\.md',
    'ARCHITECTURE_' + 'ANALYSIS',
    '任务' + '书',
    'A ' + '栈',
    'B ' + '栈',
  ].join('|'),
)

const problems = []

// 1. 扫描活代码、活脚本与活文档
const codeFiles = [
  ...walkFiles(join(ROOT, 'lib'), ['.js']),
  ...walkFiles(join(ROOT, 'DontStarveWhaleSurvivor'), ['.lua']),
  ...walkFiles(join(ROOT, 'tools'), ['.mjs']),
]

const liveDocFiles = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'README.md'),
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md')
    .map((f) => join(ROOT, 'docs', f)),
  ...readdirSync(join(ROOT, 'DontStarveWhaleSurvivor', 'guide'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(ROOT, 'DontStarveWhaleSurvivor', 'guide', f)),
].filter((f) => existsSync(f))

for (const file of [...codeFiles, ...liveDocFiles]) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, idx) => {
    const m1 = line.match(PHASE_WORD_RE)
    const m2 = line.match(LEGACY_LITERAL_RE)
    if (m1 || m2) {
      const hit = m1?.[0] ?? m2?.[0]
      problems.push(`活文件残留阶段债 (${rel}:${idx + 1}): 命中 "${hit}"`)
    }
  })
}

// 2. 校验 Markdown 相对链接
const linkCheckDocs = [
  ...liveDocFiles,
  join(ROOT, 'docs', 'CHANGELOG.md'),
].filter((f) => existsSync(f))

const MD_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g
for (const file of linkCheckDocs) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  let m
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const rawTarget = m[1].trim()
    const target = rawTarget.split('#')[0]
    if (!target || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue
    const resolved = resolve(dirname(file), target)
    if (!existsSync(resolved)) {
      problems.push(`文档断链 (${rel}): (${rawTarget}) 指向不存在的文件`)
    }
  }
}

// 3. 检查 AGENTS.md 行数上限（<= 60 行）
const agentsPath = join(ROOT, 'AGENTS.md')
if (!existsSync(agentsPath)) {
  problems.push('缺少根目录 AGENTS.md')
} else {
  const lineCount = readFileSync(agentsPath, 'utf8').trimEnd().split(/\r?\n/).length
  if (lineCount > 60) {
    problems.push(`AGENTS.md 过长（${lineCount} 行，上限 60 行）`)
  }
}

// 4. 锁文件唯一性检查
if (!existsSync(join(ROOT, 'package-lock.json'))) {
  problems.push('缺少根目录 package-lock.json')
}
for (const badLock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
  if (existsSync(join(ROOT, badLock))) {
    problems.push(`存在冲突的包管理器锁文件：${badLock}（仓库统一使用 package-lock.json）`)
  }
}

// 5. 测试文件名禁止按阶段编号命名
const PHASE_TEST_FILE_RE = new RegExp(
  '^(?:m[0-9]+[_-]|r[0-9]{2,}[_-]|survival-0[0-9]|phase-)|(?:' +
    'target' + '-refresh|' + 'native' + '-reuse)',
  'i',
)
const testFiles = walkFiles(join(ROOT, 'tests'), ['.test.mjs'])
for (const tf of testFiles) {
  const rel = relative(ROOT, tf).replace(/\\/g, '/')
  const base = rel.split('/').pop()
  if (PHASE_TEST_FILE_RE.test(base)) {
    problems.push(`测试文件仍按阶段命名：${rel}`)
  }
  const st = statSync(tf)
  if (st.size === 0) {
    problems.push(`空测试文件：${rel}`)
  }
}

if (problems.length > 0) {
  console.error('✗ 仓库卫生检查失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

console.log(
  `✓ 仓库卫生检查通过：扫描 ${codeFiles.length} 个源码/脚本 + ${liveDocFiles.length} 个活文档 + ${testFiles.length} 个测试文件，0 残留、0 断链、单一锁文件。`,
)
