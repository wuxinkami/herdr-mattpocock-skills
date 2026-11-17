# herdr-mattpocock-skills

在 [Herdr](https://herdr.dev) 中运行 [Matt Pocock skills](https://github.com/mattpocock/skills)（或任何工作流）时，只改变两件事：

1. **每个职责由谁执行**：Agent 工具、模型、思考等级。
2. **在哪执行**：可见的 Herdr 面板，或匿名的一次性 CLI。

任务拆分、依赖、TDD、审查视角、返修、验收全部按原工作流执行。本包不安装 Matt skills、Herdr 或任何 agent CLI。

## 组成

| 路径 | 作用 |
| --- | --- |
| `SKILL.md` | 入口：身份、配置、模式、开工确认、执行、归档、Git 职责 |
| `references/matt.md` | Matt 各入口的委托边界 → 身份 / 载体映射，以及 wayfinder 接力 |
| `references/herdr.md` | 面板派工、回报、关闭、故障恢复 |
| `roles/*.md` | 子会话只读取自己的那一份 |
| `templates/routing.json` | 配置模板（工具适配 + 身份配置） |
| `templates/session-log.md` | 会话归档模板 |
| `scripts/hms.mjs` | 机械操作：解析配置、生成参数、开关面板、匿名执行、回报、台账 |

## 安装

```sh
npx herdr-mattpocock-skills install --target agents,claude --project /path/to/project
npx herdr-mattpocock-skills install --target claude --global
npx herdr-mattpocock-skills status
npx herdr-mattpocock-skills uninstall --target claude --global
```

| 目标 | 项目级 | 用户级 |
| --- | --- | --- |
| `agents` | `.agents/skills/` | `~/.agents/skills/` |
| `claude` | `.claude/skills/` | `~/.claude/skills/` |
| `cursor` | `.cursor/skills/` | `~/.cursor/skills/` |
| `dsh` | `.dsh/skills/` | `$DSH_HOME/skills/` |

只需要装到你**启动主会话**的宿主即可。子会话通过派工文件里的绝对路径读取身份说明，不依赖子会话所在宿主的技能发现。

再次运行 install 就是更新：本地改过的技能文件会先备份为 `*.local-<时间>`。

## 配置

安装时会在 `~/.config/herdr-mattpocock-skills/routing.json` 生成配置（已存在则不动）。如需项目级配置，用 `config init --project-config` 生成 `<项目>/.agents/herdr/routing.json`，它的优先级更高。配置放在技能目录之外，所以更新、卸载都不会影响它。

```jsonc
"tools": {
  "codex": {
    "interactive": ["codex", "{model}", "{effort}"],
    "headless": ["codex", "exec", "--ephemeral", "{model}", "{effort}", "{prompt}"],
    "model": ["--model", "{value}"],
    "effort": ["-c", "model_reasoning_effort=\"{value}\""]
  }
},
"roles": {
  "backend":  { "tool": "codex", "model": "<模型>", "effort": "high", "carrier": "herdr", "place": "tab" },
  "searcher": { "tool": "gemini", "model": "<模型>", "effort": "default", "carrier": "background" },
  "merger":   { "inherit": "pm", "carrier": "background" }
}
```

- 同一个工具可以承担多个身份，各自用不同的模型和思考等级。
- 工具没有对应的参数映射时，相关身份只能用 `default`；否则脚本直接报错，不会悄悄换成别的值。
- 自定义 CLI（接入 Grok 等）：在 `tools` 下新增一项即可。Herdr 能识别的 agent 会获得状态和 session ID，不能识别的也能在面板中运行。
- 只装了 Codex：把所有身份的 `tool` 都设为 `codex`，再分别指定模型和思考等级。

核实将要执行的命令：

```sh
node <skill>/scripts/hms.mjs resolve --mode complex --host claude-code --host-model <模型>
node <skill>/scripts/hms.mjs argv backend
node <skill>/scripts/hms.mjs argv checker --headless
```

## 使用

在 Herdr 面板中启动主会话（secretary），调用 `$herdr-mattpocock-skills`，再照常使用 Matt 工作流：

- 普通开发：simple 模式，主会话加一个前端面板。
- `wayfinder`、`implement-spec`：complex 模式。secretary 逐张开 griller 面板；用户确认开工后再开 PM，PM 按 tickets 开 worker 面板。

归档写在 `.agents/herdr/session/`；运行时文件（派工文件、输出、inbox）写在 `.agents/herdr/run/`，建议加入 `.gitignore`。
