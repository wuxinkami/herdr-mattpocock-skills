# Matt skills 的委托边界映射

Matt 技能正文以当前环境实际安装的版本为准，本包不复制它们。派工时把需要用到的 Matt `SKILL.md` 的**绝对路径**写进正文，这样子会话不依赖自己宿主的技能发现。下表依据的上游版本是 `mattpocock/skills@5863806`；上游更新后，若出现新的 subagent 或会话边界，按同样的原则补充映射。

## 映射表

| 入口 | 原文中的委托边界 | 身份 / 载体 | 结果回到哪里 |
| --- | --- | --- | --- |
| wayfinder · 画图 | 第 5 步：每张 research 票一个 fresh subagent，并行 | searcher / 匿名，并行 | findings 文件。secretary 按原文建 `research/<name>` 分支、push、在票上写指针 |
| wayfinder · 推进 | “每个会话只解决一张票”（research 票除外） | 按票型分派，见下节 | 子会话按原文完成 claim、resolve、记录、连线后回报 |
| grilling / grill-with-docs | 查事实时开 fresh subagent | searcher / 匿名 | 报告交给发起提问的会话 |
| research | 一个 fresh 后台 agent | searcher / 匿名。searcher 就是这个后台 agent，直接执行原文第 1–3 步，不再嵌套委派 | findings 路径 |
| to-spec / to-tickets | 无 | secretary 当前会话 | — |
| implement | 无；内部会读取 tdd、code-review | 执行者当前会话：simple 下是主会话或前端面板，complex 下是 worker 面板。独立的类型检查和全量套件交 checker | 回报 PM |
| implement-spec | 整个流程 | pm 面板（complex） | — |
| ↳ exploration subagent | 可选，笔记存仓库外 | searcher / 匿名，笔记目录在派工里写明 | 笔记路径 |
| ↳ 每票一个 fresh implementer | 各自的 worktree 和分支 | 按票的内容选 frontend 或 backend，开新面板，`--cwd` 指向该 worktree | 回报 PM |
| ↳ merger subagent | fresh | merger / 匿名，`--lock` 串行 | 合并结果 |
| ↳ 对 integration branch 做 code-review | 见 code-review 行 | PM 在当前会话运行 code-review 的主流程 | — |
| ↳ “一个 fresh implementer” 修复全部审查问题 | 一个 | 一个新 worker 面板，按问题主体选 frontend 或 backend | 回报 PM |
| code-review | 两个并行的 fresh sub-agent | 调用方在当前会话执行第 1–3 步和第 5 步；Standards、Spec 两个视角各起一个 `hms run reviewer`，并行运行。每个 reviewer 只收到原文为该视角规定的 prompt 内容 | 调用方按原文分栏聚合，不合并、不重新排序 |
| improve-codebase-architecture | fresh explore subagent | searcher / 匿名 | 摩擦点报告 |
| codebase-design · design-it-twice | 3 个以上并行 fresh sub-agent | designer / 匿名，N 个并行，每个使用原文规定的独立 brief | 方案交给调用方比较 |
| handoff | 只写交接文件 | 当前会话。用户要开新会话时，`hms spawn <合适身份> --brief <交接文件>` | — |
| claude-handoff | `claude --bg` 后台会话 | 不直接调 `claude --bg`，改为 `hms spawn <目标身份> --brief <交接文件>`，按该身份的配置启动 | — |
| tdd、domain-modeling、prototype、triage、ask-matt 等 | 无 | 当前会话 | — |

“当前会话”的含义：在发起它的会话里直接读取并执行，不开新会话。

## wayfinder 推进：按票型分派

| 票型 | 处理 |
| --- | --- |
| grilling（HITL） | 开 griller 面板 |
| prototype（HITL） | 开面板，身份按原型内容选：界面类给 frontend，逻辑类给 backend，纯讨论稿给 griller。原型的取舍由用户在面板里决定 |
| research（AFK） | searcher 匿名执行；secretary 按原文记录 resolution 并关票 |
| task | 按工作内容选身份。AFK 用匿名执行；HITL 开面板，交给用户一份清单 |

## secretary 的 wayfinder 接力

1. 按 tracker 文档的 “Wayfinding operations” 查询 frontier。
2. 选票：用户指定的优先，否则取 frontier 第一张。已认领或已关闭的票跳过。secretary 自己不认领票，认领由处理该票的会话按原文第 2 步完成。HITL 面板默认同时只开一个，用户要求时可以并行。
3. 派工正文：“执行 wayfinder 的『Work through the map』，map=<引用>，ticket=<引用>；wayfinder、grilling、domain-modeling 的 SKILL.md 绝对路径；完成 = 发布 resolution comment、关票、在 map 的 Decisions so far 追加指针；用户确认决定之前不算完成。”
4. 收到 `HERDR_RESULT`（或在 inbox 看到记录）后，回到 tracker 核实：票已关闭、resolution 已发布、map 已追加指针。核实通过就 `hms close`；不通过就保留面板，并向用户说明缺什么。
5. 重复上面的步骤，直到 frontier 和 “Not yet specified” 都清空。之后：
   - 用户的目标包含实现：执行 to-spec，再执行 to-tickets（原文中的提问和确认照常进行），然后进入开工确认。
   - 用户只要求出 map：到此停止，不自动开工。

原文提醒过，其他会话可能同时在编辑 tracker；每次选票前都重新查询。

## implement-spec 中两类 worker 协作同一张票

一张票同时涉及前端和后端时，PM 可以为它各开一名 frontend 和 backend worker。两人共用这张票的 worktree 和分支，按目录划分写入范围，接口约定写在 worktree 内的一份文件里。两人都回报后，PM 按这张票的整体验收条件判断是否完成。票不重新拆分。
