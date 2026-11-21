# HMS 用一个 `grill` 身份承接需求对齐

2026-11-20 核对了 HMS `b9ea002` 和 Matt Pocock 官方仓库当日的 `main`。本文是身份设计建议，现行约定见 [HMS 产品文档](产品文档/HMS.md)。[Matt 上游版本](https://github.com/mattpocock/skills/tree/abeeaf95660ba9e8b7c753eb38f441ca707a8823)

## Wayfinder 如何消费一张票

Matt 的 Wayfinder 专讲在 07:10 展示了新的 Claude Code 会话，续办提示里带着 `/wayfinder` 和 map 链接。他在 v1.1 教程 10:45 开始的段落解释，做完就关闭当前会话，再打开下一张 Wayfinder 票。到 11:17，他说明整张 map 完成以后就可以转规格。[新会话演示 07:10](https://www.youtube.com/watch?v=F3lL98Pj90o&t=430s) · [作者讲解 10:45](https://www.youtube.com/watch?v=A8mokin_YOs&t=645s) · [配套文字教程](https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements#after-wayfinder-completes)

现行技能把建图和办票分作两次调用。建图会话发布 map 和首批票、发出研究任务后停止。办票会话重新调用 `/wayfinder`，给它 map 链接或编号，也可以指定一张票。只给 map 时，它挑一张当前可以处理的票。一场会话最多解决一张普通决策票，结束时把结论写到票里、关票，并在 map 补上指向该票的链接。研究票由全新上下文的研究子 agent 并行处理。[官方调用约定](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/wayfinder/SKILL.md#L103-L128)

## Matt 给出的其他会话边界

| 情形 | 上游做法 |
| --- | --- |
| 一场对话能定方案，开发需要多场会话 | 在代码仓库用 `/grill-with-docs` 澄清，用户确认共同理解后，在原对话依次运行 `/to-spec`、`/to-tickets`。默认到拆完票再清上下文。若上下文已长到影响推理，可在最近的阶段边界 `/compact`。许多答案只留在对话里，尤其容易在转述时丢失的是数值、顺序和排除项。[官方主流程](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md#L17-L40) · [作者对 grilling 的说明](https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs) · [规格中的细节如何丢失](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/docs/engineering/grill-with-docs.md#L54-L61) |
| 连开发也能在本会话完成 | 用户要实现时，可以从 grilling 直接在原会话 `/implement`。需要规格或工单时再走对应步骤。[官方分支选择](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md#L19-L30) |
| 整张 Wayfinder map 的决策收齐 | 给 `/to-spec` 主 map，让它沿链接读取各张决策票及其原型，汇成一份规格，再运行 `/to-tickets` 拆实际要开发的票。[map 怎样交给 to-spec](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/docs/engineering/wayfinder.md#L63-L66) |
| 从已有规格恢复拆票，或开始按票实现 | 单独调用 `/to-tickets` 时可传规格路径或 issue 引用，读取正文和评论。正常连续规划时，作者仍建议从写规格到拆票共用上下文。进入 `/implement-spec` 后每张开发票用全新的实现者会话。[拆票的输入](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/to-tickets/SKILL.md#L13-L21) · [连续规划](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/docs/engineering/to-tickets.md#L91-L99) · [逐票实现](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/implement-spec/SKILL.md#L23-L34) |

“直接转规格”仍有两处具体的人机交互。`to-spec` 综合已谈妥的需求，请用户核对从哪个接口或行为层验证功能。`to-tickets` 列出每张票交付的行为和阻塞关系，等用户认可粒度和依赖才发布。[规格的测试切入点](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/to-spec/SKILL.md#L7-L19) · [工单拆分的确认](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/to-tickets/SKILL.md#L42-L60)

## 变更前的 HMS 和调研建议

在 `b9ea002`，HMS 团队模式让秘书做 plan、grilling 和建图，显式 `wayfinder` 面板处理一张决策票。转开发工单时，秘书把决定和原型交给新开的 `spec-writer`，由它在同一会话写规格和拆票。新面板通过 `ctx:…` 复用团队配置，原 grilling 对话仍只在原会话里。[当时的派工约定](https://github.com/wuxinkami/herdr-mattpocock-skills/blob/b9ea002c60993fa2baa3980e881754ed3b83a97b/skills/herdr-mattpocock-skills/SKILL.md)

- **`secretary` 管团队通信。** 接收用户给全队或指定成员的指令，向对应面板派工、广播和收回报。用户直接在 `grill` 面板回答需求问题。现有 `hms prompt` 一次接收一个面板地址，发给多个显式面板时可逐一转发。[通信命令](../skills/herdr-mattpocock-skills/SKILL.md)
- **`grill` 负责需求对齐、规划、写规格和拆票。** 将原 `wayfinder` 和 `spec-writer` 的规划工作合在一个可配置的身份下。在仓库设计软件用 `/grill-with-docs`，不依赖仓库的讨论可用 `/grill-me`。当目标是规格与工单，原会话直接完成 `/to-spec → /to-tickets`。当目标只是讨论，用户确认共同理解就是结束点。[两种访谈入口](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md#L17-L28) · [原规格身份](https://github.com/wuxinkami/herdr-mattpocock-skills/blob/b9ea002c60993fa2baa3980e881754ed3b83a97b/skills/herdr-mattpocock-skills/roles/spec-writer.md)
- **一张 map 可以用同一个 `grill` 身份开多场会话。** 首场 `/wayfinder` 建图即回报。用户要求推进时，秘书为每张普通决策票开一个新的 `grill` 会话，传入 `/wayfinder`、map 和当前票。经用户确认，原型票直接交给独立的 `prototype` 面板，research 走研究子 agent。整图收敛后，由一个 `grill` 会话读取主 map，写规格并拆开发票。[票型](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/wayfinder/SKILL.md#L71-L80) · [整图交接](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md#L50-L54) · [HMS 原型身份](../skills/herdr-mattpocock-skills/roles/prototype.md)
- **`pm` 调度代码实现。** `grill` 把规格和开发票的入口回报秘书。到了用户要求的实现阶段，秘书交给 PM，由 PM 给实现者派 `/implement`，或用 `/implement-spec` 调度整组有依赖的票。上游小改允许就地实现，本文讨论的 HMS 团队分工把实现交给 PM。[Matt 的两种实施路径](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/ask-matt/SKILL.md#L24-L30) · [HMS 的 PM](../skills/herdr-mattpocock-skills/roles/pm.md)

现行 HMS 读取旧项目时会将 `wayfinder`、`griller`、`spec-writer` 对应到 `grill`。旧的 `wayfinder --route-from frontend` 仍可用前端模型开原型票。[身份映射](../skills/herdr-mattpocock-skills/scripts/routing.mjs) · [面板路由](../skills/herdr-mattpocock-skills/scripts/hms.mjs)
