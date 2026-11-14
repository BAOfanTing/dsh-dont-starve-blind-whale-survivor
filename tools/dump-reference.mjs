// 把游戏里的"物品 / 配方 / 合成路径 / 动作"整表 dump 成 markdown，放进 docs/reference/。
//
// 数据来自游戏本体（模组侧的 lookup 动作读 AllRecipes 和 STRINGS.NAMES），所以必须先开游戏、进世界。
//
//   node tools/dump-reference.mjs            # 生成 docs/reference/*.md
//   node tools/dump-reference.mjs --check    # 只看看能不能连上，不写文件

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCall } from './bridge-call.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'reference')
const checkOnly = process.argv.includes('--check')

const { call, readState: readGameState } = makeCall()

const state = readGameState()
if (!state.payload?.text || state.ageMs > 120_000) {
  console.error('玩家不在世界里：先开游戏进世界再跑这个脚本。')
  process.exit(2)
}
console.log(`已连上游戏（模组 ${state.payload.mod}，状态 ${Math.round(state.ageMs / 1000)} 秒前），开始 dump…`)

const lookup = async (args) => (await call('lookup', args, { timeoutMs: 60000 })).text

const recipes = await lookup({ kind: 'list', limit: 400 })
const actions = await lookup({ kind: 'action', limit: 200 })

if (checkOnly) {
  console.log(recipes.split('\n').slice(0, 5).join('\n'))
  console.log(actions.split('\n').slice(0, 5).join('\n'))
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })

const recipeCount = Number((recipes.match(/配方共 (\d+) 个/) ?? [])[1] ?? 0)
const recipeRows = recipes.split('\n').filter((line) => line.startsWith('· ')).map((line) => line.slice(2))
const actionRows = actions.split('\n').filter((line) => line.startsWith('· ')).map((line) => line.slice(2))

const header = (title, note) => `# ${title}

> 由 \`node tools/dump-reference.mjs\` 从游戏本体生成（模组读的是 \`AllRecipes\` / \`STRINGS.NAMES\`，即游戏当前语言的中文名）。
> ${note}

`

writeFileSync(join(OUT_DIR, '合成表.md'), header('合成表（全部配方）',
  `共 ${recipeCount} 个配方，格式：\`英文名/中文名\`。想知道某个怎么做：\`lookup kind=recipe q=名字\`；想看材料树：\`lookup kind=path q=名字\`。`)
  + recipeRows.map((row) => `- ${row}`).join('\n') + '\n', 'utf8')

writeFileSync(join(OUT_DIR, '动作表.md'), header('游戏里的动作（ACTIONS）',
  '模组自己实现的动作见工具列表（get_state / chop / mine / …）；这一份是游戏引擎里的 ACTIONS 表，用来对着看"这个东西能干什么"。')
  + actionRows.map((row) => `- ${row}`).join('\n') + '\n', 'utf8')

console.log(`写出 docs/reference/合成表.md（${recipeRows.length} 行）和 docs/reference/动作表.md（${actionRows.length} 行）`)
console.log('提示：合成表里只有"名字"，每条配方要展开材料请用 lookup kind=recipe。')
