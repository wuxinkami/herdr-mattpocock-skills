---
name: herdr-mattpocock-skills
description: 用户点名 HMS 时，按职责调度 Herdr 面板和匿名 agent。适用于模型自己的开发计划和 Matt 技能。
disable-model-invocation: true
---

# HMS

本页是 HMS 的操作入口，已加载即可直接用。以下 `hms` 指 `node "<本技能目录>/scripts/hms.mjs"`，在目标项目运行。配置以命令输出为准，成员职责随派工正文送达。

## 秘书与派工

用户在主会话明确启用 HMS 后，最初的主 agent 在该会话及其恢复会话里始终担任秘书。尚未启用 HMS 时，单独点名 Matt 技能就按原技能执行。收到带身份、任务和回报地址的派工时，沿用受派身份。

秘书接收用户指令、调度面板、广播意图和收回报。用户在秘书处点名技能时，把原请求和技能名交给对应身份，即使宿主已经展开了技能正文。用户在负责该需求的面板里点下一步时，由原 agent 继续。广播给多个成员时，按本轮实际接收者逐个 `hms prompt`，匿名成员由发起者传达。

| 用户要做的事 | 执行者与会话 |
| --- | --- |
| `grill-me`、`grill-with-docs`、`grilling`、`to-spec`、`to-tickets` | 开显式 `grill` 面板，由用户在里面直接回答。跟进同一需求时复用原面板。 |
| 用 `wayfinder` 建图 | 开 `grill` 面板，按 Matt 建图、派所需 research，建图后向秘书回报并停下。 |
| 用户要求推进 map | 按当前票的 `wayfinder:<type>` 标签派工。只给 map 时选下一张可办的票。每张普通决策票开新的 `grill` 显式面板，原型票直接开一个新的 `prototype` 面板，research 走 `searcher`。首条派工带上 `wayfinder`、map、当前票。整图收敛后，由一个 `grill` 会话读取主 map 和关联决策，依用户要求写规格、拆票。 |
| 独立做原型，或某个设计问题要看原型 | 秘书、PM 或需求对齐面板可派显式 `prototype`。在原型面板体验并确认，结果与原型引用回到发起者。 |
| `implement` 或 `implement-spec` | 由秘书派全队唯一的显式 PM，再由 PM 调度本票所需的实现者。研究用 `searcher`，独立评审用 `reviewer`，独立方案用 `designer`，工作流要求独立合并时用 `merger`。 |

访谈结束后保留原面板，用户可在同一条对话中继续写规格或拆票。`grill` 将已发布的规格和开发票入口回报秘书。秘书请用户选择按票实现、整组实现或收尾。用户已选实施方式时直接带着选择和产物派 PM。

## 开工身份表与本轮技能

开工前，用户可为任意身份指定本轮使用的一个或多个技能。将用户指定的技能名填入该身份的「本轮技能」栏，可一次登记多个身份，也可提前填写尚未启用的身份。用户明确要求长期使用时，再通过 `$herdr-setup` 将同一选择保存为项目默认。

秘书或 PM 开窗口时，HMS 将接收身份选定的每个技能以 `$技能名` 写入首条派工消息，与任务正文一起发送。秘书自身的本轮技能在当前主会话使用。

首次派工运行 `hms config`，已有本轮 `ctx:…` 就沿用。按阶段只核对新增或变更的身份、CLI、模型、思考等级和本轮技能，用户亲自点名的配置计作该项确认。项目缺少本次要用的身份时，用 `$herdr-setup` 的 `form 身份` 补该行，也可用 `--set 身份.tool=CLI --set 身份.model=型号` 只配置本轮。

```bash
opts=(--on "$active_roles")
# 用户每指定一行，就按实际身份和技能名追加一次；多个技能用逗号分隔
if [[ -n "${assigned_role:-}" ]]; then
  opts+=(--set "${assigned_role}.skills=${skill_names}")
fi
hms resolve "${opts[@]}"
context=$(hms init "${opts[@]}" --title "$title" --confirmed "$reply" | jq -er '.context')
hms where
hms spawn "$target_role" --context "$context" --task "$task" --prompt "$prompt"
```

同轮更改时用 `hms resolve --context "$context"` 预览，给 `hms record update --context "$context" --confirmed "$reply"` 传相同选项。用 `--set "${assigned_role}.skills="` 清空该身份的本轮列表，`--on`、`--off` 控制本轮启用的身份。将返回的新 context 传给仍在派工的成员。

## 派工与回报

每次开显式面板前先运行 `hms where`，确认输出的 `herdrSession`、`workspace`、`tab`、`pane` 是发起者自己的坐标。再用 `spawn` 在该面板旁开分屏。面板地址可用于续发和关闭。

```bash
hms where
hms spawn "$role" --context "$context" --task "$task" --prompt "$prompt"
hms prompt "$address" --prompt "$prompt"
hms notify --to "$reply_address" --task "$task" --role "$role" --status completed --summary "$summary"
hms close "$address"
```

- `spawn` 在发起面板所属的 Herdr 会话、工作区和标签页分屏。返回的 `address` 是绑定 socket 和面板的 `hms:…` 短 ID，用于续发或关闭。`delivered: false` 时先处理面板等待项，再用 `prompt` 补发返回的完整正文。再派工和回报照抄收到的 `--parent` 和 `--to` 短 ID。票级新实现者加 `--fresh --cwd "$worktree"`，沿用本轮 context。查主项目配置加 `--project "$project"`。
- 团队显式成员在 Herdr 观察到首条任务活动并取得原生会话 ID 后登记，处理等待项后用原地址补发同样适用。首条任务确认超时时，先检查面板是否已收到任务或留下草稿。任务已开始且返回 `recorded: false` 时，核实 ID 后用 `record add --run "$run"` 补登。
- 用任务正文附带的 `notify` 回报，状态可填 `completed`、`blocked`、`failed`。团队回报先入库，再投递给发起者。发起者等待审批时最多等一分钟，超时可使用原命令重发。
- 由发起者在该任务收尾后关闭自己调度的面板。`grill` 访谈结束时保留原对话，供用户继续写规格、拆票或明确收尾。借用面板保留，明确移交管理时用 `hms close "$pane" --takeover`。

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
- 旧的简单模式 context 可用 `hms record update --context "$context" --mode complex` 加本阶段所需身份接入团队台账。
- 手动启动的 Codex 使用共享 app-server 时，HMS 用当前线程 ID 匹配各 Herdr 会话的可见状态栏。定位失败时请用户在当前 Codex 的 `/statusline` 启用 `thread-id` 并移到最前，让完整 ID 显示在面板底部，然后运行 `hms where`。`--herdr-session` 是 Herdr 会话名，如 `main`。`--parent` 接受 `where` 返回的地址或面板 ID。`--session-id` 是 agent 的原生会话 ID。旧地址缺少 socket 时，可用 `--herdr-session` 指定对应会话。
- 查启动参数用 `hms argv "$role" --context "$context"`，可加 `--headless` 或 `--fresh`。
