---
name: herdr-mattpocock-skills
description: 在 Herdr 中运行 Matt Pocock skills（或任何工作流）时，把原本的父 agent、subagent、后台 agent 按职责映射到用户配置的工具、模型、思考等级，以及可见的 Herdr 面板或匿名执行。只换执行者和载体，不改工作流。用户要求用 Herdr 组织多 agent / 多模型协作，或在 Herdr 中使用 wayfinder、implement-spec 等 Matt 流程时使用；仅讨论或修改本技能时不启动团队。
---

# herdr-mattpocock-skills

本技能只决定四件事：**谁执行、用什么工具/模型/思考等级、在哪种载体上执行、结果怎样回到父会话**。任务拆分、依赖、TDD、审查视角、返修、验收一律按所用工作流原文执行；没有引用工作流时由模型自行规划，本技能只做执行端路由。

下文 `<skill>` 指本文件所在目录，`hms` 指 `node <skill>/scripts/hms.mjs`（机械操作脚本，`hms help` 看用法）。

## 1. 身份

| 身份 | 承担 |
| --- | --- |
| secretary | 用户沟通、产品设计、map / spec / tickets、设计队列、开工确认 |
| griller | 一张需要人参与的决策票 |
| pm | 实现阶段：派工、整合、提交、合并授权、服务重启 |
| frontend / backend | 编码，以及原流程要求的测试与自测 |
| searcher | research、代码库探索、外部查证 |
| reviewer | 原流程要求的每个审查视角，一个视角一个上下文 |
| checker | 构建、编译、类型检查、静态检查、委托脚本 |
| merger | PM 授权的一次合并 |
| designer | 原流程要求的独立设计方案（如 design-it-twice） |

未列出的工作交给最接近的身份；确实需要新身份时，在配置里加一个 role。

## 2. 配置

- 读取第一个存在的文件，整份生效：`<项目>/.agents/herdr/routing.json` → `~/.config/herdr-mattpocock-skills/routing.json` → `<skill>/templates/routing.json`。本轮口头指定的值用 `--set role.field=value` 覆盖，不写回文件。
- 脚本按 `tools` 的适配把模型、思考等级转成真实 CLI 参数；工具没有对应参数时直接报错。不要只在提示词里写模型名。
- `default` 表示工具默认值；`current` / `inherit` 表示当前会话的实际值，通过 `--host <tool> --host-model <m> --host-effort <e>` 如实提供，不知道就留空，表里会显示“未知”。
- 载体：`current` 当前会话；`herdr` 显式面板；`background` 匿名 CLI；`native` 宿主原生 subagent，仅当宿主正是该身份配置的工具，且能设定相同的模型与思考等级时才可用，否则改用 `background`。

## 3. 模式

- **simple（默认）**：只有两个显式会话。当前主会话兼任 secretary、pm、backend，内部不模拟传话；frontend 一个 Herdr 面板。其余身份按配置匿名执行。
- **complex**：secretary 与 pm 分开；griller 和各 worker 按工作流需要逐个开面板，数量由工作流决定。
- 工作流需要的独立会话超出 simple 的能力时（如 wayfinder 一票一会话、implement-spec 每票一个新实现者），告诉用户需要切换到 complex，取得同意后再切换，不能为维持两个窗口改写任务图。

## 4. 开工确认（只由 secretary 发起）

进入任何实现阶段之前：

1. `hms resolve --mode <m> --host ... [--set ...] [--off role,...] --write <待确认.json>`，生成本轮身份配置表（包含匿名身份，未启用的标明）。
2. 把表展示给用户，等待用户对**这张表**的明确确认。需求已确认不等于这张表已确认。
3. `hms record init ... --snapshot <待确认.json> --confirmed "<用户原话>"`：建立归档并锁定快照。
4. complex：`hms spawn pm --snapshot <快照> ...` 开 PM。simple：当前会话直接以 pm 身份继续。

同一轮内的派工、检查、审查、合并都沿用这份快照，不逐次询问。工具、模型、思考等级、载体或模式变化，以及新一轮实现开始时，由 secretary 用 `hms record confirm` 重新确认。PM 不发起开工确认。设计阶段的面板（griller、searcher 等）不需要开工确认，第一次启用时向用户报一行实际配置即可。

## 5. 执行

只接管原工作流中真实存在的委托边界：subagent、后台 agent、“fresh context”、交接到新会话。读取一个技能（grilling、tdd、domain-modeling 等）本身不开新会话。

- 显式：`hms spawn <role> --name <agent名> --task <id> --brief <正文.md> [--cwd <worktree>] [--snapshot <快照>] [--record <归档>]`
- 匿名：`hms run <role> --task <id> --brief <正文.md> [--snapshot <快照>] [--lock <锁目录>]`。需要并发的多个视角，就并行运行多个进程。
- 各 Matt 入口的映射见 [references/matt.md](references/matt.md)；回报、关闭、故障处理见 [references/herdr.md](references/herdr.md)。

派工正文只写：工作流及其 `SKILL.md` 绝对路径、本次阶段、ticket / spec / 文件指针、写入范围、完成条件。不复制父会话聊天记录。

## 6. 归档

文件为 `<docsDir>/<YYYYMMDD-HHmmss>-<秘书recap中文简称>.md`，docsDir 默认 `.agents/herdr/session`，由 `hms record init` 创建。标题取当前秘书会话的 recap；拿不到原生 recap 时由秘书写一句，并以 `--source secretary-generated` 标明来源。归档内容：实际配置表、确认记录、文档入口、显式会话台账（simple 两行，complex 每个显式会话一行，匿名执行不入表）。PM 更新同一份文件。

## 7. Git 职责

- secretary：设计、研究、原型资料。
- pm：实现阶段的提交、integration branch 的合并决策、服务重启。
- merger：执行 PM 授权的合并；同一 integration branch 同时只跑一个（`--lock`）。
- worker：只在自己的 ticket 分支 / worktree 内执行原工作流要求的 Git 操作。

提交与审查的先后顺序按原工作流。
