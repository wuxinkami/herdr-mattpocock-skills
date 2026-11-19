---
name: herdr-mattpocock-skills
description: 用户点名 HMS 时，按职责调度 Herdr 面板和匿名 agent。适用于模型自己的开发计划和 Matt 技能。
disable-model-invocation: true
---

# HMS

本页是 HMS 的操作入口，已加载即可直接用。以下 `hms` 指 `node "<本技能目录>/scripts/hms.mjs"`，在目标项目运行。配置以命令输出为准，成员职责随派工正文送达。

## 开一轮

有本轮 `context` 就沿用。首次调用运行 `hms config`，已激活即按所选模式继续，未激活才按返回的 `skillFile` 调用 `$herdr-setup`。

**简单模式（默认）**。主 agent 对话、做后端和调度。首次派工用 `hms init --title "$title"`，取返回的 `context`。有前端任务才 `spawn frontend`，同轮复用，做完由主 agent 关闭。

**团队模式**。用户说「团队」「多 agent」，或本轮 HMS 使用 wayfinder 时，当前 agent 任秘书。开发前展示本轮所需角色（含匿名角色）的 CLI、模型和等级，确认后开唯一 PM 按票派工。纯前端票由前端主责，含后端的票由后端主责，跨端在本票 worktree 依序交接。下例只派前端。

```bash
team_opts=(--mode complex --on pm,frontend --off wayfinder,backend,searcher,reviewer,designer,merger)
hms resolve "${team_opts[@]}"
# 用户确认后，沿用刚展示的选项
context=$(hms init "${team_opts[@]}" --title "$title" --confirmed "$reply" | jq -er '.context')
hms where
# 核对发起面板坐标后派工
hms spawn pm --context "$context" --task "$task" --prompt "$prompt"
```

`--on` 标记必需角色，`--off` 停用本轮不用的角色。缺少路由时用 `$herdr-setup` 补项目默认值，或用 `--set` 临时指定。已知宿主配置可传 `--host "$tool" --host-model "$model" --host-effort "$effort"`。

任务使用 Matt 时，由对应技能决定步骤、独立性和完成条件。只建 map 时用 `hms init --mode complex --title "$title"` 加所需角色，派 searcher 做 research，建完即停。用户要求串行推进时，秘书逐票开 wayfinder，传技能、map 和 ticket。进入开发才沿用该 context 预览并确认。审查用 reviewer，独立方案用 designer，流程要求独立合并时由 PM 在用户授权内派 merger。

## 派工与回报

秘书或简单模式主 agent 每次开显式面板前都先运行 `hms where`，确认输出里的 `herdrSession`、`workspace`、`tab` 和 `pane` 是自己的坐标，再用 `hms spawn` 派工。`spawn` 会重新核对并在该面板旁分屏。`where` 失败时按提示修正后重试。

```bash
hms where
# 核对发起面板坐标后派工
hms spawn "$role" --context "$context" --task "$task" --prompt "$prompt"
hms prompt "$address" --prompt "$prompt"
hms notify --to "$reply_address" --task "$task" --role "$role" --status completed --summary "$summary"
hms close "$address"
```

- `spawn` 在发起面板所属的 Herdr 会话、工作区和标签页分屏。返回的 `address` 绑定 socket 和面板，用于续发或关闭。`delivered: false` 时先处理面板等待项，再用 `prompt` 补发返回的完整正文。成员再派工用随任务收到的 `--parent`。票级新实现者加 `--fresh --cwd "$worktree"`，沿用本轮 context。查主项目配置加 `--project "$project"`。
- 用任务正文附带的 `notify` 回报，状态可填 `completed`、`blocked`、`failed`。发起者等待审批时最多等一分钟，超时保留面板和结果供重发。
- 等发送方结束回合后关闭。团队 PM 关自己的成员，秘书关 PM 和逐票 wayfinder。借用面板保留，明确移交管理时用 `hms close "$pane" --takeover`。

## 匿名派工

```bash
hms native "$role" --context "$context" --caller "$tool" --caller-model "$model" --task "$task" --prompt "$prompt"
hms run "$role" --context "$context" --task "$task" --prompt "$prompt"
hms record add --context "$context" --tool "$tool" --session-id "$id" --model "$model" --effort "$effort"
```

同工具同型号且宿主可落实等级、目录和上下文时，用 `native` 返回的参数派原生子 agent，由宿主接收结果并在团队中用 `record add` 补登。其他情况用 `run`，输出直返。两者都可加 `--cwd "$dir"`。

## 同轮配置与排障

- 用 `hms resolve --context "$context"` 加 `--set 角色.tool=CLI`、`--set 角色.model=型号`、`--set 角色.effort=等级` 或 `--on`、`--off` 预览变更。临时换 CLI 沿用项目为该 CLI 配置的唯一型号，否则问一次，可选 `default`。
- 用 `hms record update --context "$context" --confirmed "$reply"` 加相同选项更新。已经确认的团队只补确认变化项，用户点名即确认。只登记答复用 `hms record confirm --context "$context" --confirmed "$reply"`。以后续返回的 context 为准。
- 简单模式转团队用 `hms record update --context "$context" --mode complex` 并带上所需角色，沿用临时配置。展示配置并确认，原前端交接后再开 PM。团队每轮一张 `.agents/herdr/session/<时间戳>-<标题>.md`，登记会话 ID、工具、实际模型和思考等级。升级前的调用无需补记，未知值照实填。
- 手动启动的 Codex 使用共享 app-server 时，HMS 用当前线程 ID 匹配各 Herdr 会话的可见状态栏。定位失败时请用户在当前 Codex 的 `/statusline` 启用 `thread-id` 并移到最前，让完整 ID 显示在面板底部，然后运行 `hms where`。`--herdr-session` 是 Herdr 会话名，如 `main`。`--parent` 接受 `where` 返回的地址或面板 ID。`--session-id` 是 agent 的原生会话 ID。旧地址缺少 socket 时，可用 `--herdr-session` 指定对应会话。
- 查启动参数用 `hms argv "$role" --context "$context"`，可加 `--headless` 或 `--fresh`。查团队表及在线成员用 `hms ls --record "$record"`，可用 `--herdr-session "$herdr_session"` 指定会话。
