#!/usr/bin/env node
// 极简语法门禁：对 lib/ 与 tools/ 下所有 JS 跑 `node --check`。
// 不引入 eslint/prettier 依赖；真正的行为回归由 `npm test` 负责。
// 依赖 Node 22+（`node --check` 会按 package.json 的 "type":"module" 识别 ESM）。

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.m?js$/.test(name)) out.push(p)
  }
  return out
}

const files = [...walk(join(root, 'lib')), ...walk(join(root, 'tools'))]
let bad = 0
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' })
  } catch {
    bad++
    console.error(`语法错误: ${f}`)
  }
}

if (bad) {
  console.error(`\n${bad} 个文件语法检查未通过`)
  process.exit(1)
}
console.log(`✓ 语法检查通过：${files.length} 个 JS 文件`)
