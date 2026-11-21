-- 动作白名单规格表（guard 的第二道闸数据，纯数据）。
-- 从 guard.lua 抽出；加载顺序：必须在 guard.lua 之前 modimport（guard.lua 读取 Whale.guard_action_specs）。
-- 结构：动作名 = { risk / required_components / args }；args 是参数白名单（未知字段一律拒绝）。
Whale = Whale or {}
Whale.guard_action_specs = {
    move_to = {
        risk = "R1",
        required_components = { "locomotor", "health" },
        args = {
            x = { type = "number", min = -2000, max = 2000, integer = true, required = true },
            z = { type = "number", min = -2000, max = 2000, integer = true, required = true },
            timeout = { type = "number", min = 2, max = 120 },
        },
    },
    stop = {
        risk = "R1",
        required_components = { "locomotor" },
        args = {},
    },
    -- M2.1：按 #N 引用拾取地面普通资源（不准传 prefab、不准传坐标）
    pickup = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- M2.3：按 #N 收获**已成熟**的试点对象（本阶段只有普通浆果丛）。
    -- 底层原生动作是 ACTIONS.PICK（不是 ACTIONS.HARVEST —— 那是 crop/harvestable 那一类）。
    harvest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- ═══════════════ TARGET-REFRESH：实时目标选择（不依赖 #N / snapshot_id）═══════════════
    -- 为什么需要：真机 94 次调用里 23 次 pickup + 3 次 chop + 2 次 harvest 全是 stale_snapshot。
    -- #N 只在当前扫描帧内有效，而模型一轮思考 30~60 秒 —— 拿到引用时那一帧早换了。
    -- 这五个动作让模型只说"要哪一类"，由 Lua 在授权那一刻用当前世界状态重新找目标。
    -- ★ target_kind 是**固定枚举**（Whale.targetrules.KINDS），模型不能传 prefab / GUID / 表达式。
    pickup_nearest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_kind = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    pickup_food = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- 不填 = safe_ground_food（白名单地面食物，生蘑菇不算）
            target_kind = { type = "string", pattern = "^[a-z_]+$", max_len = 32 },
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    harvest_nearest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_kind = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    chop_nearest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_kind = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    mine_nearest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_kind = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    -- ═══════════════ SURVIVAL-01：四个基础生存动作 ═══════════════
    -- gather：按 #N 采集草丛/树苗（白名单在 Whale.gatherrules）
    gather = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- eat：吃背包里的白名单食物。food 可选（不填 = 服务端挑最该吃的）
    eat = {
        risk = "R1",
        required_components = { "health", "hunger", "inventory" },
        args = {
            food = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32 },
        },
    },
    -- craft：只做白名单里的工具/材料。recipe 必填且必须是白名单里的名字
    craft = {
        risk = "R2",
        required_components = { "builder", "inventory" },
        args = {
            recipe = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    -- equip：只装备白名单里的手持物品。item 必填
    equip = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    -- ═══════════ TENT（2026-11-17）：睡觉 ═══════════
    -- sleep：在帐篷 / 睡袋里睡一觉（回血回理智，掉饥饿）。
    -- Lua 侧 JOBS.sleep 早就有实现（找附近的 sleepingbag 实体或背包里的睡袋 → 推 SLEEPIN），
    -- 这里把它开放给模型。不需要 #N 引用：服务端自己在 radius 内找最近的帐篷。
    sleep = {
        risk = "R2",
        required_components = { "locomotor", "health", "hunger", "inventory" },
        args = {
            radius = { type = "number", min = 2, max = 40 },
        },
    },
    -- ═══════════ SURVIVAL-02 ═══════════
    -- gather_area：范围采集（白名单由 gatherrules/harvestrules 决定，模型只能给"只采哪种"+范围+上限）
    gather_area = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            prefab = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32 },
            radius = { type = "number", min = 2, max = 40 },
            limit = { type = "number", min = 1, max = 30, integer = true },
        },
    },
    -- seek：走出去找东西。只**报位置**，不自动采（让模型决定下一步）
    seek = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            prefab = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
            step = { type = "number", min = 4, max = 30 },
            max_tiles = { type = "number", min = 4, max = 80 },
            look = { type = "number", min = 8, max = 40 },
        },
    },
    -- ═══════════ SURVIVAL-03：批量开放的常用动作 ═══════════
    -- chop / mine / dig / hammer：对目标用 workable 动作（都要 #N 引用）
    chop = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    mine = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    dig = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    hammer = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- attack / kill：对目标重复 ATTACK（kill 打到死）
    attack = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            times = { type = "number", min = 1, max = 50, integer = true },
        },
    },
    kill = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    fight_spider = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- wait / drop
    wait = {
        risk = "R1",
        required_components = {},
        args = {
            seconds = { type = "number", min = 1, max = 30 },
        },
    },
    drop = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    -- ═══════════ SURVIVAL-04：第二批 ═══════════
    unequip = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            slot = { type = "string", pattern = "^[a-z_]+$", max_len = 16 },
        },
    },
    say = {
        risk = "R1",
        required_components = {},
        args = {
            text = { type = "string", max_len = 120, required = true },
        },
    },
    fuel = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32 },
        },
    },
    use = {
        risk = "R2",
        required_components = { "locomotor" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            action = { type = "string", pattern = "^[A-Z_]+$", max_len = 16 },
        },
    },
    inspect = {
        risk = "R1",
        required_components = {},
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
        },
    },
    -- ═══════════ SURVIVAL-05：容器 / 给予 / 烹饪 ═══════════
    container_take = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32 },
            count = { type = "number", min = 1, max = 40, integer = true },
        },
    },
    container_put = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    give = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            item = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    cook = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            -- TARGET-REFRESH：两种引用方式二选一。
            --   target_ref + snapshot_id = 当前帧的 #N（语义完全不变）
            --   target_handle           = 稳定句柄（跨扫描有效，不暴露 GUID，过期即拒）
            target_ref = { type = "string", pattern = "^#[1-9]%d*$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            target_handle = { type = "string", pattern = "^h[0-9a-z]+$", max_len = 10 },
            items = { type = "string", max_len = 120 },
        },
    },
    -- ═══════════ SURVIVAL-06：建造 / 查询 ═══════════
    build = {
        risk = "R2",
        required_components = { "locomotor", "builder" },
        args = {
            recipe = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
        },
    },
    recipes = {
        risk = "R1",
        required_components = { "builder" },
        args = {
            filter = { type = "string", pattern = "^[a-z_]*$", max_len = 32 },
            limit = { type = "number", min = 1, max = 60, integer = true },
        },
    },
    lookup = {
        risk = "R1",
        required_components = {},
        args = {
            q = { type = "string", max_len = 64, required = true },
        },
    },
    probe = {
        risk = "R1",
        required_components = {},
        args = {
            -- TARGET-REFRESH：允许数字 —— 石头真名是 rock1 / rock2（只放 [a-z_] 会挡掉它们）
            prefab = { type = "string", pattern = "^[a-z0-9_]+$", max_len = 32, required = true },
            radius = { type = "number", min = 4, max = 40 },
        },
    },
}
