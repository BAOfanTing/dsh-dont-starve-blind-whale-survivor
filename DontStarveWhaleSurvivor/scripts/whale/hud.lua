-- 游戏里的小窗（HUD）：显示大肥鱼现在在干什么，并提供快捷键自己玩
--
-- 画面上的东西全在客户端：模组在客户端建一个 widget，读插件写出来的 whale_hud.json（文字），
-- 按键 F8 让内置 AI 开始/停下、F7 让它停手（写 whale_toggle.json 给插件看）。
--
-- 所有绘图都包在 pcall 里：HUD 出问题最多不显示，绝不能把游戏搞崩。

local GLOBAL = GLOBAL
-- 沙箱里没有 pcall / tonumber / io / os（见 json.lua 顶部），从 GLOBAL 拿
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local Widget = require("widgets/widget")
local Text = require("widgets/text")
local Image = require("widgets/image")

local H = {}

local HUD_FILE = "whale_hud.json"
local HUD_IO_FILE = "whale_io_hud.json"
local TOGGLE_FILE = "whale_toggle.json"
local TOGGLE_IO_FILE = "whale_io_toggle.json"

local WIDTH = 330
local FONT_SIZE = 19
local LINE_H = 24

local root = nil
local bg = nil
local label = nil
local attached = false
local failed = false
local cached_hud = nil
local reading = false
local last_render = ""
local ai_wanted = false

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
    if root ~= nil or failed then return root end
    local ok = pcall(function()
        root = Widget("whale_hud_root")
        root:SetHAnchor(GLOBAL.ANCHOR_LEFT)
        root:SetVAnchor(GLOBAL.ANCHOR_MIDDLE)
        root:SetScaleMode(GLOBAL.SCALEMODE_PROPORTIONAL)
        root:SetPosition(28, 10, 0)

        bg = root:AddChild(Image("images/global.xml", "square.tex"))
        bg:SetTint(0, 0, 0, 0.62)
        bg:SetSize(WIDTH, LINE_H * 3 + 18)

        local font = GLOBAL.DEFAULTFONT
        label = root:AddChild(Text(font, FONT_SIZE))
        label:SetHAlign(GLOBAL.ANCHOR_LEFT)
        label:SetVAlign(GLOBAL.ANCHOR_TOP)
        label:SetColour(1, 1, 1, 1)
        label:SetString("")
        label:SetPosition(-WIDTH / 2 + 14, LINE_H, 0)
    end)
    if not ok then
        failed = true
        root = nil
        Whale.util.log("HUD 建不出来，跳过（不影响游戏）")
    end
    return root
end

local function default_lines()
    if ai_wanted then
        return { "启动中…", "等插件接手", "F8 停下" }
    end
    return { "插件没连上（DSH 没开着？）", "F8 试试让 AI 玩" }
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
        label:SetString(text)
        bg:SetSize(WIDTH, height)
        label:SetPosition(-WIDTH / 2 + 14, height / 2 - 10, 0)
    end)
end

local function refresh()
    if root == nil then return end
    poll_hud()
    local text = read_hud_text()
    if text == nil then
        render(default_lines())
        return
    end
    local ok, data = pcall(Whale.json.decode, Whale.util.strip_header(text))
    if not ok or type(data) ~= "table" then
        render(default_lines())
        return
    end
    if data.ai ~= nil then ai_wanted = data.ai and true or false end
    local title = "大肥鱼"
    if data.ai then
        title = "大肥鱼 ● 在玩" .. (data.step ~= nil and ("（第 " .. tostring(data.step) .. " 步）") or "")
    else
        title = "大肥鱼 ○ 停着"
    end
    render(data.lines, title)
end

-- ─────────────────── 快捷键 ───────────────────

local function toggle_ai()
    write_toggle(not ai_wanted, false)
    refresh()
    if GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.components.talker ~= nil then
        pcall(function()
            GLOBAL.ThePlayer.components.talker:Say(ai_wanted and "开始自己玩了" or "先停下", 2)
        end)
    end
end

local function take_over()
    write_toggle(false, true)
    refresh()
end

function H.BindKeys()
    local ok = pcall(function()
        GLOBAL.TheInput:AddKeyHandler(function(key, down)
            if not down then return end
            if key == GLOBAL.KEY_F8 then
                toggle_ai()
            elseif key == GLOBAL.KEY_F7 then
                take_over()
            end
        end)
    end)
    if not ok then Whale.util.log("绑快捷键失败") end
end

function H.Attach(owner)
    if attached or owner == nil then return end
    if GLOBAL.ThePlayer ~= nil and owner ~= GLOBAL.ThePlayer then return end
    attached = true
    ensure_widget(owner)
    if root == nil then return end
    pcall(function()
        owner:AddChild(root)
    end)
    owner:DoPeriodicTask(0.5, function()
        local ok, err = pcall(refresh)
        if not ok then
            failed = true
            pcall(function()
                root:Kill()
            end)
            root = nil
            Whale.util.log("HUD 刷新出错，关掉它：" .. tostring(err))
        end
    end)
    refresh()
end

function H.Status()
    return { attached = attached, failed = failed, ai = ai_wanted }
end

Whale = Whale or {}
Whale.hud = H
