# herdr-mattpocock-skills

HMS 按职责选择工具、模型和思考等级，适配当前开发计划或 Matt 技能。 [设计定稿](docs/产品文档/HMS.md)

在项目目录运行安装器。用 ↑↓ 选择项目或全局，回车确认。用 ↑↓ 移动到所需的 agent，按空格勾选或取消，回车开始安装。按 Esc 或 Ctrl+C 取消。

```sh
npx herdr-mattpocock-skills install
```

也可以直接指定范围和 agent。`--target` 与 `--agent` 等价。

```sh
npx herdr-mattpocock-skills install --agent codex,claude --project /path/to/project
npx herdr-mattpocock-skills install --agent codex --global
```

安装包含同仓的两个技能。首次引用 HMS 时按表填写项目所用的 CLI、模型和思考等级（默认 `high`）。`$herdr-setup` 将选择写入 `.agents/herdr/routing.json`，也可随时调整项目默认值。

Codex 和通用 `agents` 共用 `.agents/skills`，共享路径只安装一次。用户明确启用 `$herdr-mattpocock-skills` 后，主会话始终担任秘书。需求访谈、写规格和拆票由同一显式 `grill` 面板承接。原型有独立的 `prototype` 面板。秘书收到开发票后请用户选择实施方式，再交 PM 调度。

开工前可在身份表为任意身份指定一个或多个本轮技能。秘书或 PM 开窗口时，首条派工消息会引用接收身份选定的每个技能。后续只核对新增或变更的行。明确要求长期使用时才保存为项目默认值。

团队记录使用项目本地 SQLite。运行环境需要 Node.js 20 或更新版本。Node 未提供 `node:sqlite` 时，使用 PATH 上的 `sqlite3`（3.38 或更新版本）。

[HMS 操作手册](skills/herdr-mattpocock-skills/SKILL.md) · [项目路由配置](skills/herdr-setup/SKILL.md)

## Codex 安装

选择 `codex` 时，安装器向对应目录的 `hooks.json` 加入 HMS `SessionStart`，并在 `config.toml` 的状态栏首项加入 `thread-id`。已有 hooks 和状态栏条目随配置保留。

- 项目安装使用项目的 `.codex/`。
- 全局安装使用 `~/.codex/`，Windows 使用 `%USERPROFILE%\.codex\`。设置 `CODEX_HOME` 时以该目录为准。
- 项目未设置 `tui.status_line` 或数组只有 `thread-id` 时，安装器复制用户的状态栏设置，将 `thread-id` 放在首项。若 `CODEX_HOME` 指向当前项目的 `.codex/`，则从用户默认目录读取。项目已有其他状态栏项时保留项目自己的列表。

重新打开官方 `codex`，按 `/hooks` 的提示启用 HMS hook。Hook 在首个回合把 Herdr 坐标交给模型。共享 app-server 下，`hms where` 和 `hms spawn` 使用状态栏完整线程 ID 实时核对面板。 [Codex hook 文档](https://developers.openai.com/codex/hooks/)

再次安装会更新同一条 HMS hook。`status` 可检查登记情况。卸载时会移除安装器登记的 HMS hook。
