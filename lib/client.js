// 由 tools/build-client.mjs 生成，不要手改：改 lib/index.js 的 Config 或生成脚本后重新运行它。
// DSH 插件页里“配置”卡片的浏览器端模块：显示并保存这个插件的全部设置。
window.__ModuleLoader__.load({
	id: "dsh-dont-starve-blind-whale-survivor",
	factory: (require) => {
		var module = { exports: {} };
		const React = require("react");
		const h = React.createElement;
		const PACKAGE = "dsh-dont-starve-blind-whale-survivor";
		/** 插件页按 "<包名>#<行 id>" 找配置卡片；cordis.patch.yml 里这一行的 id 就是包名。 */
		const ROW_KEY = PACKAGE + "#" + PACKAGE;
		const GROUPS = [["play","游玩"],["ai","内置 AI（游戏里按 F8）"],["guide","攻略"],["session","会话与连接"],["install","模组安装"]];
		const FIELDS = [
		  {
		    "key": "port",
		    "group": "session",
		    "label": "MCP 端口",
		    "kind": "number",
		    "min": 1,
		    "max": 65535,
		    "description": "插件里 MCP 服务器的端口。地址是 http://127.0.0.1:端口/mcp。改了以后重启 DSH 才生效。"
		  },
		  {
		    "key": "gameDir",
		    "group": "install",
		    "label": "饥荒游戏目录",
		    "kind": "string",
		    "description": "《饥荒联机版》的安装目录（里面有 bin64 和 mods 的那个文件夹）。留空会自动在 Steam 库里找。"
		  },
		  {
		    "key": "bridgeDir",
		    "group": "install",
		    "label": "文件桥目录（一般不用填）",
		    "kind": "string",
		    "description": "一般不用填。自动找不到游戏的状态文件时，把游戏写出来的 whale_state.json 所在目录填在这里。"
		  },
		  {
		    "key": "actionTimeoutMinutes",
		    "group": "play",
		    "label": "单个动作最长等多少分钟",
		    "kind": "number",
		    "min": 1,
		    "max": 60,
		    "description": "单个动作最多等多少分钟（睡觉、走近路比较久）。超时会告诉模型先 get_state 看看。"
		  },
		  {
		    "key": "apiKey",
		    "group": "ai",
		    "label": "内置 AI 的 API Key",
		    "kind": "textarea",
		    "description": "内置 AI 用的 API Key（游戏里按 F8 让它自己玩，不经过 DSH 会话）。留空就读环境变量 SENSENOVA_API_KEY / DEEPSEEK_API_KEY。\n只存在你自己的 DSH 配置里，不会发到别处。"
		  },
		  {
		    "key": "baseUrl",
		    "group": "ai",
		    "label": "模型接口地址",
		    "kind": "string",
		    "description": "模型接口地址（任何 OpenAI 兼容的 /chat/completions 都行）。默认 SenseNova：https://token.sensenova.cn/v1（和 DSH 里的配置一致）。"
		  },
		  {
		    "key": "model",
		    "group": "ai",
		    "label": "内置 AI 用哪个模型",
		    "kind": "string",
		    "description": "内置 AI 用哪个模型。要支持 function calling，默认 sensenova-6.8-flash（和 DSH 模型目录里那个一致）。"
		  },
		  {
		    "key": "aiMaxTokens",
		    "group": "ai",
		    "label": "内置 AI 每次最多输出多少 token",
		    "kind": "number",
		    "min": 256,
		    "max": 8192,
		    "description": "内置 AI 每次回复最多输出多少 token。"
		  },
		  {
		    "key": "freezeTime",
		    "group": "play",
		    "label": "思考时暂停世界",
		    "kind": "boolean",
		    "description": "【已废弃，不再生效】以前是\"AI 思考时暂停世界\"。自动暂停会让刚下发的动作等不到游戏 tick，变成 result_timeout（真机踩过：chop_nearest 120 秒超时，日志里同时出现 Server Autopaused）。想暂停请玩家自己按 ESC。这一项留着只是为了老配置不报错。"
		  },
		  {
		    "key": "idleSeconds",
		    "group": "play",
		    "label": "多久没动作就暂停（秒）",
		    "kind": "number",
		    "min": 2,
		    "max": 120,
		    "description": "【已废弃，不再生效】以前配合\"思考时暂停\"用的空闲秒数。"
		  },
		  {
		    "key": "extraInstructions",
		    "group": "play",
		    "label": "额外要求",
		    "kind": "textarea",
		    "description": "给 AI 的额外要求，比如“先建好家和锅，再考虑下洞”。每次 get_state 都会看到。"
		  },
		  {
		    "key": "mainGuide",
		    "group": "guide",
		    "label": "攻略·主攻略",
		    "kind": "textarea",
		    "description": "攻略·主攻略（每次连接都会读给 AI：游戏常识、前几天怎么活下来）。改过的会推给游戏里的 AI，优先于文件；清空或改回原样就用模组自带的那份。"
		  },
		  {
		    "key": "surviveGuide",
		    "group": "guide",
		    "label": "攻略·生存",
		    "kind": "textarea",
		    "description": "攻略·生存（季节、食物、光源、建家、冬天和夏天（AI 需要时用 get_guide 读））。改过的会推给游戏里的 AI，优先于文件；清空或改回原样就用模组自带的那份。"
		  },
		  {
		    "key": "fightGuide",
		    "group": "guide",
		    "label": "攻略·战斗",
		    "kind": "textarea",
		    "description": "攻略·战斗（怪物、Boss、走位和武器（AI 需要时读））。改过的会推给游戏里的 AI，优先于文件；清空或改回原样就用模组自带的那份。"
		  },
		  {
		    "key": "cookGuide",
		    "group": "guide",
		    "label": "攻略·烹饪",
		    "kind": "textarea",
		    "description": "攻略·烹饪（锅的配方、食材、保质期（AI 需要时读））。改过的会推给游戏里的 AI，优先于文件；清空或改回原样就用模组自带的那份。"
		  },
		  {
		    "key": "presetEnabled",
		    "group": "session",
		    "label": "创建“大肥鱼饿不死”会话预设",
		    "kind": "boolean",
		    "description": "开启后会多出一个「大肥鱼饿不死」会话预设：新建会话时选它，那个会话才连上饥荒、拿到玩游戏的工具；其他会话完全不受影响。\n⚠ 已经聊过天的会话不能换预设（DSH 的规定），要玩请新建会话。\n开关改了以后重启一次 DSH。"
		  },
		  {
		    "key": "gatewayEnabled",
		    "group": "session",
		    "label": "在所有会话里提供 dst 入口工具",
		    "kind": "boolean",
		    "description": "开启后所有会话（包括老会话）都会多一个工具「dst」：常驻上下文里只有它自己的简短说明，要玩时先 action=\"help\" 把规则和动作列表读进来。不想换预设、随时想玩就开这个。"
		  },
		  {
		    "key": "autoContinue",
		    "group": "session",
		    "label": "模型回复坏了自动接着玩",
		    "kind": "boolean",
		    "description": "模型偶尔会把工具调用吐成一串坏掉的文字，DSH 会以为它说完了。开启后在这种会话里自动替它发一句“接着玩”。"
		  },
		  {
		    "key": "autoContinueMax",
		    "group": "session",
		    "label": "连续自动续玩最多几次",
		    "kind": "number",
		    "min": 1,
		    "max": 20,
		    "description": "连续自动续玩最多几次（中间有一次游戏动作成功就重新计数）。"
		  },
		  {
		    "key": "presetName",
		    "group": "session",
		    "label": "预设名字",
		    "kind": "string",
		    "description": "预设显示的名字。改了以后重启 DSH。"
		  },
		  {
		    "key": "basePreset",
		    "group": "session",
		    "label": "基础预设",
		    "kind": "string",
		    "description": "在哪个预设的基础上加饥荒工具（默认 standard）。改了以后重启 DSH。"
		  },
		  {
		    "key": "autoInstallMod",
		    "group": "install",
		    "label": "自动安装和更新饥荒模组",
		    "kind": "boolean",
		    "description": "自动把插件里带的饥荒模组装进游戏的 mods 目录，并在 modsettings.lua 里打开它。游戏开着时会等关掉后再装。"
		  },
		  {
		    "key": "sessionLogEnabled",
		    "group": "session",
		    "label": "自动写会话日志（覆盖写）",
		    "kind": "boolean",
		    "description": "自动把会话日志写进 latestLogs/（session.txt / session.jsonl / server_log.txt）。里面逐条记下：\n· AI 下的每个操作（CALL/DONE：动作名、参数、成功失败、耗时、返回原文，含 get_state 这类只读动作）\n· 游戏状态（STATE：第几天、时段、血/饿/理智、位置、背包、手持）\n· 角色周边环境（ENV：威胁/可拾取/可收获等附近物件，换帧时记一次）\n· 模组保命反射与死亡、Lua 报错等游戏日志（REFLEX/DEATH/LOG）\nsession.jsonl 是结构化版本，排查问题时按时间线对着看最方便。\n每次插件启动或新会话开始都**覆盖写**，只保留最新一次的记录，不累积历史。"
		  },
		  {
		    "key": "sessionLogDir",
		    "group": "install",
		    "label": "日志目录（留空用插件目录下 latestLogs）",
		    "kind": "string",
		    "description": "日志目录。留空就用插件目录下的 latestLogs/。也可填绝对路径（例如把日志放到仓库里方便分析）。"
		  }
		];

		const box = { border: "1px solid rgba(128,128,128,.35)", borderRadius: 8, padding: "12px 16px", marginBottom: 16 };
		const input = { font: "inherit", color: "inherit", background: "transparent", border: "1px solid rgba(128,128,128,.45)", borderRadius: 6, padding: "4px 8px" };
		const hint = { fontSize: 12, opacity: 0.65, margin: "4px 0 0", whiteSpace: "pre-wrap" };
		const button = { font: "inherit", color: "inherit", background: "rgba(128,128,128,.15)", border: "1px solid rgba(128,128,128,.45)", borderRadius: 6, padding: "4px 14px", cursor: "pointer" };

		function same(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}

		/** 用户层里写过这个字段（哪怕值和默认一样）才算改过，“恢复默认”只对它有意义。 */
		function overridden(state, key) {
			return state.user !== null && typeof state.user === "object" && Object.prototype.hasOwnProperty.call(state.user, key);
		}

		function Field({ field, value, onChange, disabled }) {
			if (field.kind === "boolean") {
				return h("input", { type: "checkbox", checked: value === true, disabled, onChange: (e) => onChange(e.target.checked) });
			}
			if (field.kind === "number") {
				return h("input", {
					type: "number", step: 1, min: field.min, max: field.max, disabled,
					style: { ...input, width: 110 },
					value: value === undefined || value === null ? "" : String(value),
					onChange: (e) => onChange(e.target.value === "" ? undefined : Number(e.target.value)),
				});
			}
			if (field.kind === "select") {
				return h("select", { disabled, value: value === undefined || value === null ? "" : value, style: input, onChange: (e) => onChange(e.target.value) },
					field.options.map((o) => h("option", { key: o.value, value: o.value }, o.label)));
			}
			if (field.kind === "textarea") {
				const text = typeof value === "string" ? value : "";
				return h("textarea", {
					disabled, value: text,
					rows: Math.min(18, Math.max(3, text.split("\n").length + 1)),
					style: { ...input, width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 },
					onChange: (e) => onChange(e.target.value),
				});
			}
			return h("input", { type: "text", disabled, value: typeof value === "string" ? value : "", style: { ...input, width: 280 }, onChange: (e) => onChange(e.target.value) });
		}

		/** 数字超出范围、不是整数时不让保存，返回错误说明。 */
		function invalid(field, value) {
			if (field.kind !== "number") return null;
			if (typeof value !== "number" || !Number.isInteger(value)) return "要填整数";
			if (field.min !== undefined && value < field.min) return "不能小于 " + field.min;
			if (field.max !== undefined && value > field.max) return "不能大于 " + field.max;
			return null;
		}

		function ConfigCard(props) {
			const form = props.form;
			const state = form ? form.state : undefined;
			const [draft, setDraft] = React.useState({});
			const [cleared, setCleared] = React.useState({});
			const [message, setMessage] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const revision = state ? state.revision : undefined;
			// DSH 接受新的设置（别处改的，或者刚保存的）以后丢掉本地草稿
			React.useEffect(() => {
				setDraft({});
				setCleared({});
			}, [revision]);

			if (props.view === "summary") return "端口、游戏目录、思考时暂停、攻略和会话预设等设置";
			if (!form) return h("p", { style: hint }, "DSH 还没把这个插件的设置交给页面：确认插件在运行，或者重启一次 DSH。");
			if (state.status === "loading") return h("p", { style: hint }, "正在读取设置…");
			if (state.status !== "ready" || !state.value) return h("p", { style: hint }, "这个插件的设置现在读不到（DSH 没有对这个页面开放它）。");

			const current = state.value;
			const valueOf = (key) => (key in draft ? draft[key] : current[key]);
			const changed = FIELDS.filter((f) => cleared[f.key] || (f.key in draft && !same(draft[f.key], current[f.key])));
			const errors = changed.map((f) => (cleared[f.key] ? null : invalid(f, draft[f.key]))).filter(Boolean);
			const disabled = saving || !state.writable;

			const save = async () => {
				const ops = changed.map((f) => (cleared[f.key] ? { op: "unset", path: [f.key] } : { op: "set", path: [f.key], value: draft[f.key] }));
				setSaving(true);
				setMessage(null);
				try {
					const ok = await form.mutate(ops, state.revision);
					setMessage(ok ? "已保存。改动会在十几秒内同步到游戏。" : "DSH 没有接受这次修改，已重新读取当前设置。");
					if (ok) {
						setDraft({});
						setCleared({});
					}
				} catch (error) {
					setMessage("保存失败：" + (error && error.message ? error.message : String(error)));
				} finally {
					setSaving(false);
				}
			};

			const row = (field) => {
				const wide = field.kind === "textarea";
				const error = field.key in draft && !cleared[field.key] ? invalid(field, draft[field.key]) : null;
				const canReset = overridden(state, field.key) && !cleared[field.key];
				return h("div", { key: field.key, style: { margin: "12px 0" } },
					h("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
						h("label", { style: { minWidth: 200, fontWeight: 500 } }, field.label),
						wide ? null : h(Field, { field, value: valueOf(field.key), disabled, onChange: (v) => {
							setDraft({ ...draft, [field.key]: v });
							setCleared({ ...cleared, [field.key]: false });
						} }),
						canReset ? h("button", { type: "button", style: { ...button, padding: "2px 8px", fontSize: 12 }, disabled, onClick: () => setCleared({ ...cleared, [field.key]: true }) }, "恢复默认") : null,
						cleared[field.key] ? h("span", { style: hint }, "保存后恢复默认") : null),
					wide ? h("div", { style: { marginTop: 6 } }, h(Field, { field, value: valueOf(field.key), disabled, onChange: (v) => {
						setDraft({ ...draft, [field.key]: v });
						setCleared({ ...cleared, [field.key]: false });
					} })) : null,
					error ? h("p", { style: { ...hint, color: "#e5534b", opacity: 1 } }, error) : null,
					field.description ? h("p", { style: hint }, field.description) : null);
			};

			return h("div", null,
				GROUPS.map(([id, title]) => h("section", { key: id, style: box },
					h("h4", { style: { margin: "0 0 4px" } }, title),
					FIELDS.filter((f) => f.group === id).map(row))),
				h("div", { style: { display: "flex", alignItems: "center", gap: 12, position: "sticky", bottom: 0, padding: "8px 0" } },
					h("button", { type: "button", style: button, disabled: disabled || changed.length === 0 || errors.length > 0, onClick: save },
						saving ? "保存中…" : changed.length > 0 ? "保存 " + changed.length + " 项改动" : "保存"),
					changed.length > 0 && !saving ? h("button", { type: "button", style: button, onClick: () => { setDraft({}); setCleared({}); setMessage(null); } }, "撤销") : null,
					!state.writable ? h("span", { style: hint }, "DSH 的配置文件现在不能写入，只能查看。") : null,
					message ? h("span", { style: hint }, message) : null));
		}

		module.exports.name = PACKAGE + "-client";
		module.exports.inject = ["slots"];
		module.exports.apply = function apply(ctx) {
			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: ROW_KEY }, ConfigCard));
		};
		module.exports.FIELDS = FIELDS;
		return module.exports;
	}
});
