---
name: herdr-mattpocock-skills
description: 用户点名 HMS 时，按职责调度 Herdr 面板和匿名 agent。适用于模型自己的开发计划和 Matt 技能。
disable-model-invocation: true
---

# HMS

`hms` 指 `node <本技能目录>/scripts/hms.mjs`。先查 `hms config`。未激活时按返回的 `skillFile` 调用 `$herdr-setup`。临时换 CLI 沿用项目为它配置的唯一型号。没有或有多个时问一次，用户也可选 `default`。

**简单模式（默认）**　当前 agent 对话、做后端、负责调度。首次有前端任务再开前端面板，同轮复用，做完由主 agent 关闭。

**团队模式**　用户说“团队”“多 agent”，或已启用 HMS 的任务使用 wayfinder，即进入团队。当前 agent 任[秘书](roles/secretary.md)。开发前用 `resolve --mode complex --on 本轮所需身份` 展示工具、型号和等级，含按需匿名身份。用户确认后开唯一的 [PM](roles/pm.md) 按票派工。

Matt 决定步骤、上下文和完成条件。建 map 时以 searcher 派 research，建完即停。用户要求串行推进时，秘书逐票开 wayfinder，发送技能、map 和 ticket 引用。审查用 reviewer，独立方案用 designer，独立合并用 merger。

首次派工用 `hms init --title <简称>` 取得本轮 context，带上已选配置。团队加 `--mode complex` 才建成员表。同轮转团队用 `record update --context C --mode complex`，从此开始登记，沿用临时配置，旧前端交接后再开 PM。用 `resolve --context C` 展示配置，`record confirm --context C --confirmed <答复>` 确认。派工与回报见 [AGENTS.md](AGENTS.md)。
