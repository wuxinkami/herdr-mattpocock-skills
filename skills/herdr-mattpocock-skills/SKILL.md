---
name: herdr-mattpocock-skills
description: 用户点名 HMS 时，按职责调度 Herdr 面板和匿名 agent。适用于模型自己的开发计划和 Matt 技能。
disable-model-invocation: true
---

# HMS

本页是 HMS 的操作入口，已加载即可直接用。以下 `hms` 指 `node "<本技能目录>/scripts/hms.mjs"`，在目标项目运行。配置以命令输出为准，成员职责随派工正文送达。

## 开一轮

有本轮 `ctx:…` 短 ID 就沿用，传给 `--context`。首次调用运行 `hms config`，已激活即按所选模式继续，未激活才按返回的 `skillFile` 调用 `$herdr-setup`。

**简单模式（默认）**。主 agent 对话、做后端和调度。首次派工用 `hms init --title "$title"`，取返回的 `context`。有前端任务才 `spawn frontend`，同轮复用，做完由主 agent 关闭。

**团队模式**。用户说「团队」「多 agent」，或本轮 HMS 使用 wayfinder 时，当前 agent 任秘书。开发前展示本轮所需角色（含匿名角色）的 CLI、模型和等级，确认后开唯一 PM 按票派工。纯前端票由前端主责，含后端的票由后端主责，跨端在本票 worktree 依序交接。下例只派前端。

```bash
team_opts=(--mode complex --on pm,frontend --off wayfinder,spec-writer,backend,searcher,reviewer,designer,merger)
hms resolve "${team_opts[@]}"
# 用户确认后，沿用刚展示的选项
context=$(hms init "${team_opts[@]}" --title "$title" --confirmed "$reply" | jq -er '.context')
hms where
# 核对发起面板坐标后派工
hms spawn pm --context "$context" --task "$task" --prompt "$prompt"
```

`--on` 标记必需角色，`--off` 停用本轮不用的角色。缺少路由时用 `$herdr-setup` 补项目默认值，或用 `--set` 临时指定。已知宿主配置可传 `--host "$tool" --host-model "$model" --host-effort "$effort"`。

任务使用 Matt 时，由对应技能决定步骤、独立性和完成条件。只建 map 时用 `hms init --mode complex --title "$title"` 加所需角色，派 searcher 做 research，建完即停。用户要求串行推进时，秘书逐票开 wayfinder，传技能、map 和 ticket。审查用 reviewer，独立方案用 designer，流程要求独立合并时由 PM 在用户授权内派 merger。

## 从决策到开发工单

1. 用户要求把已定决策转成规格和开发工单时，秘书用 `--on spec-writer` 预览并更新本轮配置。项目路由缺这一行时用 `$herdr-setup` 补填，临时选择用 `--set`。取新 `context`，用 `hms spawn spec-writer --context "$context" --task "$task" --prompt "$prompt"` 开面板。正文附 `to-spec`、`to-tickets` 的技能引用、已确认的决策和相关原型。有 Wayfinder map 时附 map 链接，规格编写者按链接读取决策票结论。
2. `spec-writer` 在同一面板依序完成 `to-spec` 和 `to-tickets`，当面和用户核对测试切入点、工单拆分及阻塞关系。两项产物发布后，用 `notify` 向秘书回报规格和开发工单入口，可用 Issue 链接或本地路径。
3. 秘书收到回报后，按本轮开发配置确认，用 `spawn pm` 将两个引用和 `implement-spec` 技能交给 PM。PM 按工单依赖推进实现。

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

秘书按票的产物选启动配置。页面或前端交互原型用 `--route-from frontend`，从主项目的 `roles.frontend` 读取 CLI、模型和等级，即使本轮已 `--off frontend`。其他原型可借用与工作性质相符的项目角色配置。普通 grilling 直接用 Wayfinder 的配置。两张票可以沿用同一 context，各自选参数。

```bash
hms argv wayfinder --context "$context" --route-from frontend
hms where
# 核对坐标后派页面原型票
hms spawn wayfinder --context "$context" --task "$prototype_ticket" --route-from frontend --prompt "$prototype_prompt"
hms where
# 核对坐标后派普通 grilling 票
hms spawn wayfinder --context "$context" --task "$grilling_ticket" --prompt "$grilling_prompt"
```

正文附 wayfinder 技能、map 和对应票。页面原型会话以 Wayfinder 身份认领、讨论原型、请用户确认、关票、更新 map 并向秘书回报。

- `spawn` 在发起面板所属的 Herdr 会话、工作区和标签页分屏。返回的 `address` 是绑定 socket 和面板的 `hms:…` 短 ID，用于续发或关闭。`delivered: false` 时先处理面板等待项，再用 `prompt` 补发返回的完整正文。再派工和回报照抄收到的 `--parent` 和 `--to` 短 ID。票级新实现者加 `--fresh --cwd "$worktree"`，沿用本轮 context。查主项目配置加 `--project "$project"`。
- 团队显式成员在 Herdr 观察到首条任务活动并取得原生会话 ID 后登记，处理等待项后用原地址补发同样适用。首条任务确认超时时，先检查面板是否已收到任务或留下草稿。任务已开始且返回 `recorded: false` 时，核实 ID 后用 `record add --run "$run"` 补登。
- 用任务正文附带的 `notify` 回报，状态可填 `completed`、`blocked`、`failed`。团队回报先入库，再投递给发起者。发起者等待审批时最多等一分钟，超时可使用原命令重发。
- 等发送方结束回合后关闭，由各发起者关闭自己调度的面板。借用面板保留，明确移交管理时用 `hms close "$pane" --takeover`。

## 匿名派工

```bash
hms native "$role" --context "$context" --caller "$tool" --caller-model "$model" --task "$task" --prompt "$prompt"
hms run "$role" --context "$context" --task "$task" --prompt "$prompt"
hms record add --context "$context" --role "$role" --tool "$tool" --session-id "$id" --model "$model" --effort "$effort"
```

同工具同型号且宿主可落实等级、目录和上下文时，用 `native` 返回的参数派原生子 agent，由宿主接收结果。团队登记时将返回的执行 ID 传给 `record add --run "$run"`。其他情况用 `run`，输出直返，成功退出且返回原生 ID 时自动登记。两者都可加 `--cwd "$dir"`。

## 查记录与恢复

团队台账在主项目的 `.agents/herdr/state/hms.sqlite3`。每轮仍生成 `.agents/herdr/session/<时间戳>-<标题>.md`，用户可直接查看秘书恢复命令和已登记成员。旧表可用 `hms ls --record "$record"` 原路径导入。有旧 context 时用 `hms ls --context "$context"` 一并登记配置。

- 查本轮执行用 `hms ls --round "$round"`。加 `--run "$run"` 查看单次派工正文和结果。跨 worktree 按轮次 ID 查库时加 `--project "$project"`。
- 重启后，在 Herdr 中运行索引里的命令恢复秘书，再从秘书会话执行 `hms recover --round "$round"`。已在线的会话沿用原面板，未完成的 Codex 和 Claude 会话按原生 ID 恢复。根据返回的任务状态、面板地址和回报地址续发工作，先看 `pendingReports`。旧表中只有会话信息的成员列在 `historical`，其他需人工判断的执行列在 `manual` 或标为 `needs_attention`。

## 同轮配置与排障

- 用 `hms resolve --context "$context"` 加 `--set 角色.tool=CLI`、`--set 角色.model=型号`、`--set 角色.effort=等级` 或 `--on`、`--off` 预览变更。临时换 CLI 沿用项目为该 CLI 配置的唯一型号，否则问一次，可选 `default`。
- 用 `hms record update --context "$context" --confirmed "$reply"` 加相同选项更新。已经确认的团队只补确认变化项，用户点名即确认。只登记答复用 `hms record confirm --context "$context" --confirmed "$reply"`。以后续返回的 context 为准。
- 简单模式转团队用 `hms record update --context "$context" --mode complex` 并带上所需角色，沿用临时配置。展示配置并确认，原前端交接后再开 PM。
- 手动启动的 Codex 使用共享 app-server 时，HMS 用当前线程 ID 匹配各 Herdr 会话的可见状态栏。定位失败时请用户在当前 Codex 的 `/statusline` 启用 `thread-id` 并移到最前，让完整 ID 显示在面板底部，然后运行 `hms where`。`--herdr-session` 是 Herdr 会话名，如 `main`。`--parent` 接受 `where` 返回的地址或面板 ID。`--session-id` 是 agent 的原生会话 ID。旧地址缺少 socket 时，可用 `--herdr-session` 指定对应会话。
- 查启动参数用 `hms argv "$role" --context "$context"`，可加 `--headless` 或 `--fresh`。
