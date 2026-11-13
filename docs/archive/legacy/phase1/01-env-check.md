# 里程碑 1：环境检查报告

> 本报告里每一条都是在这台机器上实测/实读出来的，没有凭记忆填的部分。
> 采集时间：2026-11-11 20:50（Asia/Shanghai）

## 1. 操作系统与工具链

| 项 | 值 | 来源 |
|---|---|---|
| 系统 | Microsoft Windows 10 家庭中文版 build 19045（64 位） | `Win32_OperatingSystem` |
| PowerShell | 5.1.19041.6456 | `$PSVersionTable` |
| Node.js | v24.13.1 | `node -v` |
| pnpm | 12.15.0 | `pnpm -v` |
| TypeScript | 未全局安装（`npx tsc` 失败） | `npx --no-install tsc -v` |

**结论**：Node 可用；TypeScript 需要在 `bridge/` 项目里作为 devDependency 安装（里程碑 7 处理）。

## 2. 游戏安装与版本

| 项 | 值 |
|---|---|
| 游戏 | 《饥荒联机版》Don't Starve Together |
| 安装目录 | `E:\SteamLibrary\steamapps\common\Don't Starve Together` |
| 版本 | `762172`（`version.txt` 与 `client_log.txt` 里的 `Version: 762172` 一致） |
| 可执行文件 | `bin64\dontstarve_steam_x64.exe` |
| 模组目录 | `<游戏>\mods` |
| 模组启用文件 | `<游戏>\mods\modsettings.lua` |

`mods` 目录现状（实测）：

```
DontStarveWhaleSurvivor/        ← 之前那个项目装的模组（本阶段不动它）
workshop-2049203096/  workshop-362175979/  workshop-462434129/  workshop-501385076/
dedicated_server_mods_setup.lua
modsettings.lua
```

**本项目的模组目录名定为 `BlindWhaleSurvivor`，与已有目录不冲突。**

## 3. 存档与日志位置

存档根目录在 OneDrive 下（“文档”被 OneDrive 接管）：

```
C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\
├─ client_log.txt              客户端日志
├─ client_chat_log.txt
├─ master_server_log.txt       地面世界（Master 分片）服务端日志
├─ caves_server_log.txt        洞穴（Caves 分片）服务端日志
├─ master_server_chat_log.txt / caves_server_chat_log.txt
└─ 893016408\
   ├─ client_save\            客户端持久化数据
   └─ Cluster_1|2|3\         存档槽
      ├─ Master\{save,server_log.txt}
      └─ Caves\{save,server_log.txt}
```

实测到的日志行格式（`master_server_log.txt`）：

```
[00:00:27]: [大肥鱼饿不死] 文件桥已启动（服务端）：写 whale_state.json
```

即：**每一行都是 `[hh:mm:ss]: ` + 原始 `print()` 内容**。这一点决定了日志传输方案：

- 模组 `print("[BWS] {...}")` → 日志里变成 `[00:00:27]: [BWS] {...}`
- Bridge 只认 `[BWS] ` 标记之后的 JSON，忽略时间戳前缀和其它模组/引擎的输出。

## 4. Lua 模组加载机制（读 762172 的 `scripts.zip` 源码确认）

| 环节 | 事实 | 来源 |
|---|---|---|
| 启用方式 | `mods/modsettings.lua` 里 `ForceEnableMod("<目录名>")`；**该文件执行时 `ModManager` 还不存在**，写 `ModManager:AddMod` 会让游戏启动直接崩 | `scripts/modindex.lua:1083 UpdateModSettings` |
| 入口文件 | `modinfo.lua`（元信息）→ `modworldgenmain.lua`（可无）→ `modmain.lua` | `scripts/mods.lua` 加载流程 |
| 模块引用 | `modimport("scripts/xxx.lua")`，相对于 `MODROOT`；文件内 `return` 值不会被使用，所以用全局表传值 | `scripts/mods.lua:339 env.modimport` |
| 钩子 | `AddGamePostInit` / `AddPlayerPostInit` / `AddClassPostConstruct` / `AddPrefabPostInit` / `AddComponentPostInit` | `scripts/modutil.lua` |
| 配置项 | `modinfo.lua` 的 `configuration_options`，模组里用 `GetModConfigData(name)` 读（在 mod 环境上，不在 `GLOBAL`） | `scripts/modutil.lua:329` |
| 端 | 客户端与服务端**都**会加载 `modmain.lua`；服务端权威数据在 Master/Caves 分片进程里 | `scripts/mods.lua` |

### 沙箱白名单（很关键，踩过坑）

`scripts/mods.lua:296 CreateEnvironment` 只把这些放进 mod 环境：

```
pairs ipairs print math table type string tostring require Class TUNING
CHARACTERLIST(部分) GROUND/WORLD_TILES/LOCKS/KEYS/LEVELTYPE/LEVELCATEGORY
GLOBAL  modname  MODROOT  env  modimport  + modutil 注入的一批 AddXxx / GetModConfigData
```

**没有 `pcall` / `xpcall` / `tonumber` / `error` / `assert` / `os` / `io`**——这些必须通过 `GLOBAL.xxx` 取（`GLOBAL` 就是引擎的 `_G`，里面有）。

## 5. 本阶段要用到的游戏 API（逐条在 762172 源码里确认）

| 数据 | API | 文件:行 |
|---|---|---|
| 是否权威端 | `TheWorld.ismastersim` | 由 `world.lua` 设置 |
| 玩家实体集合（服务端） | `AllPlayers`（userid → entity） | `scripts/mainfunctions.lua` |
| 玩家位置 | `ent.Transform:GetWorldPosition()` → x, y, z | `scripts/entityscript.lua` |
| 生命 | `inst.components.health.currenthealth / maxhealth / GetPercent() / IsDead()` | `components/health.lua:477,546` |
| 饥饿 | `inst.components.hunger.current / max / GetPercent()` | `components/hunger.lua:94` |
| 精神 | `inst.components.sanity.current / max / GetPercent()` | `components/sanity.lua:288` |
| 体温 | `inst.components.temperature:GetCurrent()` | `components/temperature.lua:108` |
| 潮湿 | `inst.components.moisture:GetMoisture()` | `components/moisture.lua:167` |
| 背包槽位 | `inv:GetNumSlots()` / `inv:GetItemInSlot(slot)` / `inv:ForEachItem(fn)` | `components/inventory.lua:588,777,667` |
| 装备 | `inv:GetEquippedItem(EQUIPSLOTS.HANDS/HEAD/BODY)` | `components/inventory.lua:773` |
| 物品数量 | `item.components.stackable:StackSize()` | `components/stackable.lua:59` |
| 耐久 / 新鲜度 | `finiteuses:GetUses()` + `.total`；`perishable:GetPercent()` | `finiteuses.lua:75,110`；`perishable.lua:217` |
| 天数 / 阶段 / 季节 | `TheWorld.state.cycles` / `.phase` / `.season` | `components/clock.lua`（世界状态） |
| 天气 | `TheWorld.state.israining` / `.issnowing` / `.iswet` / `.precipitation` | 同上 |
| 世界温度 | `TheWorld.state.temperature` | 同上 |
| 附近实体 | `TheSim:FindEntities(x, y, z, r, musttags, canttags, mustoneoftags)` | `scripts/mainfunctions.lua` |
| 物品中文名 | `STRINGS.NAMES[string.upper(prefab)]` | `scripts/strings.lua` |
| 周期性任务 | `ent:DoPeriodicTask(period, fn)` | `entityscript.lua` |

**已知的坑（都在源码里验证过，避免"虚构 API"）：**

- `Pickable` 组件**没有** `CanBePicked()` 方法——状态靠实体标签 `pickable` / `barren`。
- `Builder:MakeRecipeFromMenu` / `MakeRecipeAtPoint` 在服务端会因"背包没被打开"直接 `return`（本阶段不涉及操作，但记下来）。
- 持久化字符串文件带 `KLEI     1 ` 头（本阶段走日志，不走它）。

## 6. 数据来源与端侧结论（决定架构）

| 数据 | 只在客户端有？ | 只在服务端有？ | 本阶段取哪个 |
|---|---|---|---|
| 天数/季节/昼夜/天气 | 都有（客户端有 replica） | 权威 | **服务端**（`TheWorld.state`） |
| 玩家位置、生命、饥饿、精神 | 客户端有 replica | 权威 | **服务端**（`components.*`） |
| 背包/装备 | 客户端有 replica | 权威 | **服务端** |
| 附近实体 | 客户端只同步视距内 | 全量 | **服务端**（`TheSim:FindEntities`） |
| 当前界面/鼠标 | 只有客户端 | 无 | 本阶段不做 |

**结论：观察器全部跑在服务端（Master 分片），日志输出到 `master_server_log.txt`。**

## 7. 风险与限制（写进文档，不藏着）

1. 服务端进程的 `print` 落在 `master_server_log.txt`；如果玩家下洞穴，玩家实体在 Caves 分片，需要同时盯 `caves_server_log.txt`（里程碑 7 处理）。
2. 日志每行带 `[hh:mm:ss]: ` 前缀，JSON 只能放在标记之后；不能跨行（Bridge 需要处理半截行）。
3. 模组沙箱没有 `io`/`os`，写文件只能走 `TheSim:SetPersistentString`（本阶段不用）；`os.time()` 也别直接用。
4. `GET /api/game/state` 的数据新鲜度取决于采样间隔（默认 2 秒）；不是逐帧实时。
5. 主线程原则：扫描用 `DoPeriodicTask` 定周期，且限制半径和返回数量；绝不在 `OnUpdate` 里全量遍历。

## 8. 结论

环境满足开发条件：

- 游戏可装本地模组，启用方式与日志路径已确认；
- 本阶段需要的只读 API 全部在 762172 里存在且能取到；
- 日志格式足够做结构化传输（`[BWS]` 标记 + 单行 JSON）；
- 下一步（里程碑 2）可以开始写最小模组并验证加载。
