// 动作规格总表：按领域拆分，合并成唯一一份 ACTION_SPECS。
//
// 为什么拆：原来 1252 行的 dispatcher.js 把 31 个动作、参数校验、下发、核对全挤在一起，
// 改一个动作要在上千行里找位置。现在按领域分文件（参照星露谷版 GameActions.*.cs 的切法）。
// 新增动作只需要动对应领域的文件：OPEN_ACTIONS、提示词能力清单都从这张表自动派生。

import { movementSpecs } from './movement.js'
import { gatheringSpecs } from './gathering.js'
import { craftingSpecs } from './crafting.js'
import { infoSpecs } from './info.js'
import { interactionSpecs } from './interaction.js'
import { survivalSpecs } from './survival.js'
import { socialSpecs } from './social.js'
import { combatSpecs } from './combat.js'

export const ACTION_SPECS = {
  ...movementSpecs,
  ...gatheringSpecs,
  ...craftingSpecs,
  ...infoSpecs,
  ...interactionSpecs,
  ...survivalSpecs,
  ...socialSpecs,
  ...combatSpecs,
}
