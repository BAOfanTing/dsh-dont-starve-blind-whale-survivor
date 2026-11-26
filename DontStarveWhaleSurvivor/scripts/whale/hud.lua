-- 游戏里的小窗（HUD）：显示大肥鱼现在在干什么，并提供快捷键自己玩
--
-- 画面上的东西全在客户端：模组在客户端建一个 widget，读插件写出来的 whale_hud.json（文字）。
-- 按键：F8 让内置 AI 开始/停下（写 whale_toggle.json 给插件看）；
--       F7 只显示/隐藏这个小窗，不碰 AI，也不打断正在做的事。
--
-- 所有绘图都包在 pcall 里：HUD 出问题最多不显示，绝不能把游戏搞崩。

local GLOBAL = GLOBAL
-- 沙箱里没有 pcall / tonumber / io / os（见 json.lua 顶部），从 GLOBAL 拿
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

-- 专用服务器 / 洞穴服务端没有客户端显示树。这里用 pcall 取 widgets：
-- 取不到就把 HUD 当成"这个进程不支持"直接跳过，绝不让 require 失败把整条 modimport 打断。
local ok_widget, Widget = pcall(require, "widgets/widget")
local ok_text, Text = pcall(require, "widgets/text")
local ok_image, Image = pcall(require, "widgets/image")
local ui_available = ok_widget and ok_text and ok_image

local H = {}

local HUD_FILE = "whale_hud.json"
local HUD_IO_FILE = "whale_io_hud.json"
local TOGGLE_FILE = "whale_toggle.json"
local TOGGLE_IO_FILE = "whale_io_toggle.json"

local WIDTH = 330
local FONT_SIZE = 19
local LINE_H = 24
-- 右上角面板：距离屏幕右/上边缘的内边距
local MARGIN = 12
local PANEL_MIN_H = LINE_H * 3 + 18
-- F8 切换后的一小段时间窗：以"本地刚按下的意图"为准，避免被旧 HUD 文本瞬间覆盖。
local OPTIMISTIC_WINDOW = 2

local root = nil
local bg = nil
local label = nil
local attached = false
local failed = false
local build_fail_logged = false
local cached_hud = nil
local reading = false
local last_render = ""
local ai_wanted = false
local hud_visible = true       -- F7 只控制这个：隐藏后照常刷新，下次显示就是最新的
local attach_fail_logged = false
-- F8 乐观切换截止时间（os.time 秒）。在此之前，refresh 不采纳插件回写的旧 ai 状态。
local optimistic_until = 0

-- ─────────────────── 文件读写（io 优先，退回持久化字符串） ───────────────────

local function io_read(name)
    if io == nil or io.open == nil then return nil end
    local ok, file = pcall(io.open, name, "r")
    if not ok or file == nil then return nil end
    local content = nil
    pcall(function()
        content = file:read("*a")
        file:close()
    end)
    if content == nil or content == "" then return nil end
    return content
end

local function io_write(name, text)
    if io == nil or io.open == nil then return false end
    local ok, file = pcall(io.open, name, "w")
    if not ok or file == nil then return false end
    local wrote = pcall(function()
        file:write(text)
        file:close()
    end)
    return wrote
end

local function read_hud_text()
    local text = io_read(HUD_IO_FILE)
    if text ~= nil then return text end
    return cached_hud
end

local function poll_hud()
    if reading then return end
    reading = true
    local ok = pcall(function()
        GLOBAL.TheSim:GetPersistentString(HUD_FILE, function(success, data)
            reading = false
            if success and data ~= nil and data ~= "" then cached_hud = data end
        end)
    end)
    if not ok then reading = false end
end

--- 写“让 AI 开始/停下”的开关，插件那边每半秒看一次
local function write_toggle(on, stop_now)
    ai_wanted = on and true or false
    local payload = Whale.json.encode({
        ai = ai_wanted,
        stop = stop_now and true or false,
        ts = os.time(),
    })
    io_write(TOGGLE_IO_FILE, payload)
    pcall(function()
        GLOBAL.TheSim:SetPersistentString(TOGGLE_FILE, payload, false)
    end)
end

-- ─────────────────── 界面 ───────────────────

local function ensure_widget(owner)
    -- ★ failed 不能作为永久闸门：玩家还在读档、字体/控件树暂时没准备好时，
    --   构造失败一次就永远不再试，会表现为“HUD 代码在跑但小窗一直不出现”。
    --   现在允许调用方每秒重试；日志只打一次，避免刷屏。
    if root ~= nil or not ui_available then return root end
    failed = false
    local ok = pcall(function()
        root = Widget("whale_hud_root")
        -- ★ 放到屏幕**右上角**：左侧是游戏原生 UI（背包/状态/出生点徽标）的地盘，
        --   小窗压在左边会被原生控件盖住，表现为"文字看不见/左半截被吃掉"。
        root:SetHAnchor(GLOBAL.ANCHOR_RIGHT)
        root:SetVAnchor(GLOBAL.ANCHOR_TOP)
        root:SetScaleMode(GLOBAL.SCALEMODE_PROPORTIONAL)
        -- 子控件（bg / label）都以 root 原点为中心摆放；root 原点放在
        -- "右边缘左移 MARGIN+WIDTH/2、上边缘下移 MARGIN+PANEL_H/2" 处，
        -- 整块面板就落在 [右-MARGIN-WIDTH, 右-MARGIN] × [上+MARGIN, 上+MARGIN+PANEL_H]。
        root:SetPosition(-(MARGIN + WIDTH / 2), -(MARGIN + PANEL_MIN_H / 2), 0)

        bg = root:AddChild(Image("images/global.xml", "square.tex"))
        bg:SetTint(0, 0, 0, 0.62)
        bg:SetSize(WIDTH, PANEL_MIN_H)

        local font = GLOBAL.DEFAULTFONT
        label = root:AddChild(Text(font, FONT_SIZE))
        -- Text 必须先设置 region size 再左对齐，否则 SetHAlign 仅按自身中心排版导致左半截越界。
        label:SetRegionSize(WIDTH - 28, LINE_H * 3 + 2)
        label:SetHAlign(GLOBAL.ANCHOR_LEFT)
        label:SetVAlign(GLOBAL.ANCHOR_TOP)
        label:SetColour(1, 1, 1, 1)
        label:SetString("")
        label:SetPosition(0, 0, 0)
        -- 新控件是空的：把上次的渲染缓存清掉，否则 render 会以为"没变化"直接跳过，
        -- 出现"新建了 HUD 但小窗一片空白"。
        last_render = ""
    end)
    if not ok then
        failed = true
        root = nil
        label = nil
        bg = nil
        if not build_fail_logged then
            build_fail_logged = true
            Whale.util.log("HUD 暂时建不出来，稍后重试（不影响游戏）")
        end
    end
    return root
end

local function default_lines()
    if ai_wanted then
        return { "启动中…", "等插件接手", "F8 停下 · F7 隐藏" }
    end
    return { "插件没连上（DSH 没开着？）", "F8 让 AI 玩 · F7 隐藏小窗" }
end

local function render(lines, title)
    if root == nil or label == nil then return end
    local list = lines
    if type(list) ~= "table" or #list == 0 then list = default_lines() end
    local head = title ~= nil and tostring(title) or "大肥鱼"
    local parts = { head }
    for i = 1, math.min(#list, 6) do
        parts[#parts + 1] = tostring(list[i])
    end
    local text = table.concat(parts, "\n")
    if text == last_render then return end
    last_render = text
    local height = LINE_H * #parts + 16
    pcall(function()
        -- 面板高度随行数变化：重新把 root 原点居中到"右上角那块面板"的中心。
        root:SetPosition(-(MARGIN + WIDTH / 2), -(MARGIN + height / 2), 0)
        label:SetString(text)
        label:SetRegionSize(WIDTH - 28, height - 20)
        label:SetHAlign(GLOBAL.ANCHOR_LEFT)
        label:SetVAlign(GLOBAL.ANCHOR_TOP)
        label:SetPosition(0, 0, 0)
        bg:SetSize(WIDTH, height)
    end)
end

local function refresh()
    if root == nil then return end
    poll_hud()
    local pending = os.time() < optimistic_until
    local text = read_hud_text()
    local ok, data = false, nil
    if text ~= nil then
        ok, data = pcall(Whale.json.decode, Whale.util.strip_header(text))
    end
    -- ★ 只在"解码成功且不处于刚按 F8 的乐观窗口"时采纳插件回写的 ai 状态，
    --   否则按 F8 的瞬间会被插件旧文本改回去（真机：想开始却显示"先停下"）。
    if ok and type(data) == "table" and data.ai ~= nil and not pending then
        ai_wanted = data.ai and true or false
    end
    local step = (ok and type(data) == "table") and data.step or nil
    local title
    if ai_wanted then
        title = "大肥鱼 ● 在玩" .. (step ~= nil and ("（第 " .. tostring(step) .. " 步）") or "")
    else
        title = "大肥鱼 ○ 停着"
    end
    if pending then
        render({ ai_wanted and "正在启动…" or "正在停下…" }, title)
        return
    end
    if not ok or type(data) ~= "table" then
        render(default_lines(), title)
        return
    end
    render(data.lines, title)
end

-- ─────────────────── 快捷键 ───────────────────

local function toggle_ai()
    local want = not ai_wanted
    -- 先按本地意图落状态并进入短乐观窗口，再写开关、重绘、提示——
    -- 提示语与实际意图严格对应（want=true 说"开始"，want=false 说"先停下"）。
    ai_wanted = want
    optimistic_until = os.time() + OPTIMISTIC_WINDOW
    write_toggle(want, false)
    refresh()
    if GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.components ~= nil
            and GLOBAL.ThePlayer.components.talker ~= nil then
        pcall(function()
            GLOBAL.ThePlayer.components.talker:Say(want and "开始自己玩了" or "先停下", 2)
        end)
    end
end

--- F7：只显示/隐藏 HUD。隐藏不写 whale_toggle.json，AI 该干嘛还干嘛。
--- 隐藏时被人按 F7 显示，如果小窗还没挂上（读档晚于屏幕创建），这里顺手重试挂载。
function H.SetVisible(on)
    hud_visible = on and true or false
    if hud_visible and root == nil then
        pcall(H.AttachFromPlayer, GLOBAL.ThePlayer)
    end
    if root ~= nil then
        pcall(function()
            if hud_visible then root:Show() else root:Hide() end
        end)
    end
    return hud_visible
end

function H.ToggleVisible()
    local on = H.SetVisible(not hud_visible)
    if GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.components ~= nil
            and GLOBAL.ThePlayer.components.talker ~= nil then
        pcall(function()
            GLOBAL.ThePlayer.components.talker:Say(on and "小窗打开了" or "小窗关了（F7 再开）", 2)
        end)
    end
    return on
end

-- ─────────────────── 客户端：服务端在挪我的时候，把动画补上 ───────────────────
--
-- DST 里人物动画由客户端自己产生（player_classified 没有 ismoving 这类同步字段）：
-- 纯 move_to 我们会让客户端自己也走一遍（有动画）；但**动作**（砍树/捡东西/打架时走到目标旁边）
-- 那一段是服务端引擎在走，客户端只负责画位置 —— 表现就是"走到树边在滑行"。
-- 这里在客户端加一个纯视觉的看门狗：发现"位置在变，但自己的状态机没在走"，就自己播 run_loop；
-- 停下再回到 idle_loop。它**不碰移动**，所以不会和服务端抢角色。

local MOVE_SPEED = 1.2   -- 世界单位/秒，低于这个算没动

--- 纯函数，方便测：这个 tick 该播什么动画（nil = 别管）
function H.anim_for(speed, sg_moving)
    if sg_moving then return nil end          -- 自己在走（玩家操作或客户端预测），交给状态机
    if speed ~= nil and speed > MOVE_SPEED then return "run_loop" end
    return "idle_loop"
end

local watch = { x = nil, z = nil, t = nil, forced = false }

function H.WatchServerMove(owner, every)
    if owner == nil or owner.Transform == nil then return end
    local gettime = GLOBAL.GetTime
    owner:DoPeriodicTask(every or 0.12, function(p)
        local ok = pcall(function()
            if p == nil or not p:IsValid() then return end
            local x, _, z = p.Transform:GetWorldPosition()
            local now = gettime ~= nil and gettime() or nil
            local speed = nil
            if watch.x ~= nil and now ~= nil and watch.t ~= nil and now > watch.t then
                local dx, dz = x - watch.x, z - watch.z
                speed = math.sqrt(dx * dx + dz * dz) / (now - watch.t)
            end
            watch.x, watch.z, watch.t = x, z, now
            local sg_moving = p.sg ~= nil and p.sg:HasStateTag("moving")
            local want = H.anim_for(speed, sg_moving)
            if want == "run_loop" then
                if not p.AnimState:IsCurrentAnimation("run_loop") then
                    p.AnimState:PlayAnimation("run_loop", true)
                end
                watch.forced = true
            elseif want == "idle_loop" and watch.forced then
                watch.forced = false
                if not p.AnimState:IsCurrentAnimation("idle_loop") then
                    p.AnimState:PlayAnimation("idle_loop")
                end
            end
        end)
        if not ok then watch.forced = false end
    end)
end

-- ─────────────────── 客户端：服务端让我们走，我们真的走 ───────────────────
--
-- DST 里人物的走路/跑步动画是客户端自己预测出来的（player_classified 里没有
-- ismoving/isrunning 这类同步字段）：服务端只改物理位置的话，玩家看到的就是"平移滑行"。
-- 所以服务端在 GoToPoint 之后用 mod RPC 通知这边，让客户端的 locomotor 也走一遍，
-- sg 自己会进 run 状态 → 动画、脚步声、朝向都正常；位置仍以服务端为准。

local function install_walk_rpc()
    local add = (env ~= nil and env.AddClientModRPCHandler) or GLOBAL.AddClientModRPCHandler
    if add == nil then return end
    local name = Whale.actions ~= nil and Whale.actions.MODNAME or "DontStarveWhaleSurvivor"

    pcall(add, name, "walkto", function(x, z, run)
        local p = GLOBAL.ThePlayer
        if p == nil or p.components == nil or p.components.locomotor == nil then return end
        pcall(function()
            p.components.locomotor:GoToPoint(GLOBAL.Vector3(x, 0, z), nil, run == 1)
        end)
    end)

    pcall(add, name, "walkstop", function()
        local p = GLOBAL.ThePlayer
        if p == nil or p.components == nil or p.components.locomotor == nil then return end
        pcall(function()
            p.components.locomotor:Stop()
            p:ClearBufferedAction()
        end)
    end)
end

install_walk_rpc()

function H.BindKeys()
    if H._keys_bound then return end
    local ok = pcall(function()
        GLOBAL.TheInput:AddKeyHandler(function(key, down)
            if not down then return end
            if key == GLOBAL.KEY_F8 then
                toggle_ai()
            elseif key == GLOBAL.KEY_F7 then
                H.ToggleVisible()
            end
        end)
    end)
    if ok then
        H._keys_bound = true
    else
        Whale.util.log("绑快捷键失败")
    end
end

--- 把 HUD 挂到 PlayerHud 屏幕上。
---
--- AddClassPostConstruct("screens/playerhud") 的第一个参数 self 才是屏幕，HUD root 必须挂到屏幕而非 owner 上。
---   owner 只是屏幕持有的玩家实体。
---
--- 返回值 = 是否挂上。挂不上时**不**把 failed 永久置真：
--- PlayerHud 可能比模组晚建、玩家可能还在读档，调用方可以隔一秒再试。
function H.Attach(screen, player)
    if attached then return true end
    if not ui_available then return false end
    local p = player or (screen ~= nil and screen.owner) or GLOBAL.ThePlayer
    if p == nil then return false end
    if GLOBAL.ThePlayer ~= nil and p ~= GLOBAL.ThePlayer then return false end
    -- 允许调用方只给玩家：玩家实体的 HUD 字段就是 PlayerHud 屏幕（原生构造时挂上的）。
    screen = screen or p.HUD
    if screen == nil or screen.AddChild == nil then return false end
    ensure_widget(screen)
    if root == nil then return false end
    local added = pcall(function()
        screen:AddChild(root)
    end)
    if not added then
        pcall(function() root:Kill() end)
        root = nil
        label = nil
        bg = nil
        if not attach_fail_logged then
            attach_fail_logged = true
            Whale.util.log("HUD 暂时挂不到 PlayerHud 屏幕上，稍后重试（不影响游戏）")
        end
        return false
    end
    attached = true
    -- P0：无洞穴单机监听服(ismastersim 且客户端)下 bridge.start_client 可能不触发，这里幂等补绑一次快捷键
    if not H._keys_bound then
        pcall(H.BindKeys)
    end
    if root ~= nil then
        pcall(function()
            if hud_visible then root:Show() else root:Hide() end
        end)
    end
    Whale.util.log("HUD 已挂上（画面右上角）")
    pcall(function()
        p:DoPeriodicTask(0.5, function()
            local ok, err = pcall(refresh)
            if not ok then
                failed = true
                attached = false
                pcall(function()
                    root:Kill()
                end)
                root = nil
                Whale.util.log("HUD 刷新出错，关掉它：" .. tostring(err))
            end
        end)
    end)
    -- 服务端挪人的时候把走路/跑步动画补上（纯视觉，见 WatchServerMove 注释）
    pcall(H.WatchServerMove, p)
    refresh()
    return true
end

--- 从玩家实体找 PlayerHud 并挂上；给"模组加载晚于屏幕创建"的情况兜底。
function H.AttachFromPlayer(player)
    local p = player or GLOBAL.ThePlayer
    if p == nil then return false end
    return H.Attach(p.HUD, p)
end

function H.Status()
    return { attached = attached, failed = failed, ai = ai_wanted, visible = hud_visible }
end

Whale = Whale or {}
Whale.hud = H
