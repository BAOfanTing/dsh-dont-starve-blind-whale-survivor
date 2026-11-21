#!/usr/bin/env node
// README 工具清单「防漂」闸门：确保文档里的动作/本地工具数量、工具集和代码一致。
//
// 用法：
//   node tools/check-tools-doc.mjs          # 校验；不一致时退出码 1
//   node tools/check-tools-doc.mjs --write  # 自动把 README 的计数行改成代码真实数字
//
// 说明：README 那张表是人工按「用途」整理的（比纯生成更好读），所以这里不重写整张表，
// 只死守两条不变量：
//   1) 计数行「模型能用的 N 个动作 + M 个本地工具（共 K 个工具）」必须等于代码真实值；
//   2) 每个真实工具名都必须在 README 里以 `name` 形式出现过（防止改名/新增后文档漏记）。
// 计数的唯一事实来源是 lib/actions/specs 的 ACTION_SPECS 与 lib/tools.js 的 TOOLS。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ACTION_SPECS } from '../lib/actions/specs/index.js'
import { TOOLS } from '../lib/tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(root, 'README.md')

const actionNames = Object.keys(ACTION_SPECS)
const allNames = TOOLS.map((t) => t.name)
const localNames = allNames.filter((n) => !actionNames.includes(n))

const counts = { actions: actionNames.length, local: localNames.length, total: allNames.length }
const expectedLine = `**模型能用的 ${counts.actions} 个动作 + ${counts.local} 个本地工具（共 ${counts.total} 个工具）**`
const countRe = /\*\*模型能用的\s*\d+\s*个动作\s*\+\s*\d+\s*个本地工具（共\s*\d+\s*个工具）\*\*/

const write = process.argv.includes('--write')
let readme = readFileSync(readmePath, 'utf8')

if (write) {
  const m = readme.match(countRe)
  if (!m) {
    console.error('无法自动修正：README 里找不到计数行（格式应为「**模型能用的 N 个动作 + M 个本地工具（共 K 个工具）**」）')
    process.exit(1)
  }
  if (m[0] !== expectedLine) {
    readme = readme.replace(countRe, expectedLine)
    writeFileSync(readmePath, readme)
    console.log(`已更新 README 计数行 → ${expectedLine}`)
  } else {
    console.log('README 计数行已正确，无需修改')
  }
}

const problems = []
const m = readme.match(countRe)
if (!m) {
  problems.push('README 里找不到「模型能用的 N 个动作 + M 个本地工具（共 K 个工具）」计数行')
} else if (m[0] !== expectedLine) {
  problems.push(`README 计数行与代码不一致：\n    文档: ${m[0]}\n    代码: ${expectedLine}`)
}

const missing = allNames.filter((n) => !readme.includes('`' + n + '`'))
if (missing.length) {
  problems.push(`README 未提到这些工具（应以 \`name\` 形式出现）：${missing.join(', ')}`)
}

if (problems.length) {
  console.error('✗ 工具文档校验失败：')
  for (const p of problems) console.error('  - ' + p)
  if (!write) console.error('\n提示：`npm run check:docs:fix` 可自动修正计数行；缺的工具名请手动补进 README 表。')
  process.exit(1)
}

console.log(`✓ 工具文档校验通过：${counts.actions} 动作 + ${counts.local} 本地 = ${counts.total} 个工具，README 与代码一致。`)
