# dsh-dont-starve-blind-whale-survivor（DSH 插件说明）

让 AI 在 DSH 里玩《饥荒联机版》。插件里塞了四样东西：

1. 一个**本机 MCP 服务器**（`http://127.0.0.1:18090/mcp`）：把游戏动作暴露成 MCP 工具；
2. 一层**文件桥**：饥荒的 Lua 模组不能开端口，所以 MCP 服务器和模组之间用 json 文件说话；
3. **饥荒 Lua 模组**本身（`DontStarveWhaleSurvivor/`，自动装进游戏 `mods`），带画面上的小窗和 F8/F7 快捷键；
4. 一个**内置 AI**：不经过 DSH 会话，插件自己调模型玩——游戏里按 F8 就开。

设置项见 README 的表；这篇说怎么用、为什么这么设计。

## 三种玩法

| 玩法 | 怎么开 | 适合 |
|---|---|---|
| 内置 AI（游戏里的 F8） | 设置里填「内置 AI 的 API Key」，进游戏按 **F8** | 一边自己看着玩，一边让 AI 操纵角色；不用开 DSH 会话 |
| 会话预设 | 设置里打开「创建“大肥鱼饿不死”会话预设」，新建会话时选它 | 在 DSH 里和 AI 讨论着玩：每个动作是独立工具、参数检查更严、规则一开始就在上下文里 |
| `dst` 入口工具 | 设置里打开「在所有会话里提供 dst 入口工具」 | 随手玩：任何会话（包括老会话）多一个小工具，先 `action="help"` 读规则再玩 |
| 别的 MCP 客户端 | 把 `http://127.0.0.1:18090/mcp` 填进 WorkBuddy / Claude Code / Cursor | 不用 DSH 的额度 |

后三种可以同时打开；预设的改动只影响之后新建的会话，已经聊过天的会话不能换预设（DSH 的限制）。

内置 AI 跑着的时候，DSH 里的动作类工具会回“先按 F8 停掉它”——两边不会抢同一个角色。

## 画面上的小窗

模组在客户端挂了一个 widget（画面左边，三个状态球下面），每秒读一次插件写出来的 `whale_hud.json`：

- 标题行：`大肥鱼 ● 在玩（第 N 步）` / `大肥鱼 ○ 停着`；
- `正在做：` 当前工具调用（哪个动作、什么参数）；
- `结果：` 上一个动作的返回（太长的截断）；
- 底行提醒快捷键。

按键（`TheInput:AddKeyHandler`，客户端）：

| 键 | 作用 |
|---|---|
| F8 | 让内置 AI 开始 / 停止自己玩（写 `whale_toggle.json`，插件每半秒看一次） |
| F7 | 只显示 / 隐藏游戏里的 HUD 小窗，不碰 AI，也不打断正在做的事 |

小窗和按键全部包在 `pcall` 里：HUD 出问题最多是不显示，不会把游戏搞崩。

## 为什么用文件桥

星露谷那版是 SMAPI（.NET）模组，能在游戏进程里直接开 HTTP 服务，DSH 直接连游戏就行。

饥荒不一样：模组是 Lua，跑在游戏沙箱里，**没有监听端口的 API**。可行又稳的连接方式只有文件：

- 模组用 `TheSim:SetPersistentString` 写状态（落在存档目录）和 `io.open` 写状态（落在游戏进程的工作目录），两条通道都写；
- 插件每 150 毫秒看一眼最新的状态文件，写指令时两条通道都写；
- 模组读到指令 → 用游戏的动作系统执行 → 写结果 → 插件把结果回给模型。

这样做的代价是每次动作多几十毫秒的延迟（可以忽略），好处是不用改游戏、不用注入进程、不会因为网络被防火墙拦。

## 思考时暂停世界

饥荒是实时生存：AI 想 20 秒，角色就饿 20 秒、天黑就挨打。打开「思考时暂停世界」后：

- 插件在没有新动作时往游戏写 `whale_pause.json`；
- 客户端的模组读到它，调用 `SetServerPaused(true)` 把世界冻住（只有房主有权限）；
- 下一次有动作时先取消暂停。

默认是**关**的：暂停会让游戏画面卡住（人类在旁边看着会觉得奇怪），而且只在单人本地世界里靠得住。

## 自动装模组

插件每 60 秒检查一次：`<游戏>/mods/DontStarveWhaleSurvivor` 在不在、版本一样不一样，不一样就整个复制过去；同时保证 `mods/modsettings.lua` 里有 `ModManager:AddMod("DontStarveWhaleSurvivor")`（只追加，不覆盖你自己写的内容）。游戏开着时文件被占用，会等关掉后再装。

## 模型回复坏了自动续玩

模型偶尔把工具调用吐成一串坏掉的文字（比如 `</｜｜DSML｜｜ invoke>`），DSH 会以为它说完了，这一轮就停。开启后，插件盯着会话事件：这一轮调用过 `dst` 工具、最后一条回复是这种坏掉的工具调用、这一轮正常结束 → 等会话空闲后自动发一句“接着玩”（用 `agent.followup`）。连续失败超过上限就不再续。

## 安装到 DSH

**从插件市场**：装 `dsh-dont-starve-blind-whale-survivor`（插件就在仓库根目录）。

**从本地文件夹（开发时）**，在 profile 目录（`<DSH_HOME>/profiles/desktop` 或 `web`）里：

1. `package.json` 的 `dependencies` 加 `"dsh-dont-starve-blind-whale-survivor": "link:E:/Cache/XinLuguWuyu/dsh-dont-starve-blind-whale-survivor"`；
2. `dsh.profile.bundles` 里加 `"dsh-dont-starve-blind-whale-survivor"`；
3. 在 profile 目录跑 `pnpm install`，然后重启 DSH。

注意用和这个 profile 一致的 pnpm（看 `node_modules/.modules.yaml` 里的 `packageManager`，桌面版是 DSH 自带的 pnpm 11）。

配置结构需要 `@deepseek-ai/schemastery`。用 `link:` 装时插件会去 `DSH_HOME` 的 profile 目录和 DSH 程序目录里找；找不到也不会加载失败，只是配置卡片读不到设置，插件按默认值工作。

改了 `lib/index.js` 的 `Config` 以后跑 `npm run build:client` 重新生成配置卡片，测试会检查它是不是最新的。

## 测试

```bash
node --test "tests/*.test.mjs"
```

不需要打开游戏：用一个「假游戏」（只会读写那几个 json 文件）测文件桥和 MCP 服务器；用 `fengari`（Lua 虚拟机的 JS 实现）真跑一遍 `json.lua`；用 `luaparse` 检查所有 Lua 文件的语法。

## 常见问题

- **`get_state` 说连不上游戏**：游戏没开、没读档进世界、模组没启用，或者「大肥鱼饿不死」在模组列表里被关掉了。模组装好后必须重新读档一次。
- **操作不了角色**：这个模组是服务器端模组，只在你自己开的世界里生效；去别人服务器当客户端不生效。
- **`SetServerPaused` 无效**：不是房主、或者在别人的服务器里。关了「思考时暂停世界」就行。
- **端口冲突**：改设置里的「MCP 端口」，重启 DSH。游戏那边不用改（模组不占端口）。
- **想从外面接 MCP**：`curl http://127.0.0.1:18090/status` 看现在连没连上游戏。
