# herdr-mattpocock-skills

复用 agent 环境中已安装的 Matt Pocock skills，保留原工作流正文，由 Herdr 编排各步骤使用的 agent 和模型，附带零依赖 npm 安装器。通过显式面板和匿名执行端划分职责，每个身份可独立配置 agent 工具、模型和思考等级；**秘书在进入实现前展示配置、取得用户确认并归档，然后开启 PM 执行所选流程。**

安装后使用 `$herdr-mattpocock-skills` 调用技能；安装器命令为 `herdr-mattpocock-skills`。

当前版本：`0.4.0`。需要 Node.js 20 或更新版本。Matt skills 使用当前执行端已有的安装；本包只管理 Herdr 适配文件。安装器不会安装 Matt、Herdr、agent CLI、模型或登录凭据，也不会启动开发任务。

## 安装

以下命令使用本地 npm 包，不依赖本包已经在公共 npm registry 发布。把项目路径换成自己的目录。

```sh
# 交互选择宿主；默认安装到当前项目
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills install

# 一次安装到多个宿主
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills install \
  --agent codex,claude-code,cursor,dsh --project /path/to/project

# 只安装到项目通用 .agents/skills 目录
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills install \
  --agent universal --project /path/to/project

# 用户级安装
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills install \
  --agent codex,claude-code,cursor,dsh --global
```

非交互环境须指定 `--agent`，支持重复参数和逗号分隔。`--dry-run` 只显示计划，`--no-activate` 不添加自动加载入口。

| 宿主 | 项目级技能目录 | 用户级技能目录 | 项目自动加载入口 |
| --- | --- | --- | --- |
| `codex` | `.agents/skills/herdr-mattpocock-skills` | `~/.agents/skills/herdr-mattpocock-skills` | `AGENTS.md` |
| `claude-code` | `.claude/skills/herdr-mattpocock-skills` | `~/.claude/skills/herdr-mattpocock-skills` | `CLAUDE.md` |
| `cursor` | `.cursor/skills/herdr-mattpocock-skills` | `~/.cursor/skills/herdr-mattpocock-skills` | `.cursor/rules/herdr-mattpocock-skills.mdc` |
| `dsh` | `.dsh/skills/herdr-mattpocock-skills` | `$DSH_HOME/skills/herdr-mattpocock-skills`，默认 `~/.dsh/skills/herdr-mattpocock-skills` | `AGENTS.md` |
| `universal` | `.agents/skills/herdr-mattpocock-skills` | `~/.agents/skills/herdr-mattpocock-skills` | `AGENTS.md` |

`universal --global` 须加 `--no-activate`，再由实际宿主加载。`codex` 与 `universal` 共用目录时去重。安装器只管理自己的规则标记块，不替换原有规则。

自定义技能父目录用 `--dir /absolute/skills`，实际位置为其下的 `herdr-mattpocock-skills`；宿主须能发现此目录。安装目标与职责使用的工具是独立选择：在 Codex 中安装，也可以让 Claude Code 承担前端。

## 编辑自己的默认模板

```sh
# 导出可修改模板
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills config --template > ./my-agents.json

# 编辑 my-agents.json 后，为新安装使用这份配置
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills install \
  --agent codex,claude-code --project /path/to/project --defaults ./my-agents.json

# 已安装时，查看生效配置的位置
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills config \
  --agent codex --project /path/to/project --path
```

[默认模板](templates/agent-defaults.json) 中的组合是示例，请按工具可用性、模型权限和预算修改。安装后只编辑技能根目录的 `routing.json`，更新保留它；不会把新模板悄悄混入现有配置。`--defaults` 仅用于首次生成配置。

| 配置 | 含义 |
| --- | --- |
| `tools.<名称>.command` | 实际命令及固定参数的数组，例如 `["codex"]`、`["claude"]` 或自己的启动器 |
| `roles.<身份>.tool/model/effort` | 此身份使用的工具、模型 ID、思考等级 |
| `roles.<身份>.carrier` | 当前会话、Herdr、匿名后台或经验证的原生子 agent |
| `roles.merger.inheritRole` | 设为 `pm` 时继承本轮确认后的实际 PM 工具、模型和等级 |
| `simple.main` | 简单模式合并主会话的身份及真实工具配置 |
| `docsDir` | 项目相对归档目录，默认 `.agents/herdr/session` |

身份包括 secretary、griller、pm、frontend、backend、searcher、checker、reviewer、merger。griller 可与秘书使用不同工具和模型。merger 如需独立配置，替换继承条目为完整的 `tool/model/effort/carrier`，不要混用两种写法。

`default/inherit/current` 是待解析指示，不是 CLI 参数或已核实的模型名称。每个工具的思考等级分别核实；不会用一份跨工具枚举假定兼容。匿名 searcher 可指定外部工具，或在工具、模型和等级确实匹配时选择 `native`。reviewer/checker 保持 `background`，griller 保持 `herdr`。

本轮临时指定值可覆盖默认配置，不自动写回。多个宿主分别安装时各有配置，但一次任务始终使用秘书确认的同一份快照，派工时随材料传递。

## 两种模式

| 模式 | 使用方式 |
| --- | --- |
| 简单模式 | 两个显式会话：主会话合并秘书、PM、后端及配置中合并的 searcher，前端独立 Herdr；检查与审查匿名执行 |
| 复杂模式 | 秘书保留设计上下文，独立 griller 处理设计票，新的 PM 协调实现，按 tickets 开 worker；匿名身份按配置执行 |

默认 `defaultMode` 为 `simple`，用户可修改。明确要求完整协作或使用需要多会话的 Matt 流程时，按实际图使用复杂模式，不为保持两个窗口改写任务图。仅讨论、安装或修改此技能不会启动团队。

简单模式中也由秘书身份展示开工配置，再在主会话承担 PM；不另开 PM，也不模拟内部传话。要让 searcher 独立后台运行，可从 `simple.main.roles` 移除 searcher，使用其 `roles` 配置，仍只有两个显式会话。

## 秘书确认、归档，再启动 PM

1. 秘书准备目标、所选流程及其所需文档。
2. 展示每个身份的用途、工具、实际模型、思考等级、载体；匿名身份也列入，未用身份标“本轮不启用”。
3. 用户确认后，秘书归档完整表格与确认记录。
4. 复杂模式才新开 PM，将已确认配置快照、归档路径和规范入口交给它。PM 直接执行所选 `implement` 或 `implement-spec`，不重复发起开工确认。

同一轮 tickets、检查、review、合并不逐次确认配置。实际工具、模型、等级、载体或模式需要变化时，由秘书展示变更并确认；已确认内容不被接收端的默认配置覆盖。

归档格式：

```text
.agents/herdr/session/<YYYYMMDD-HHmmss>-<当前秘书recap中文简称>.md
```

例如 `.agents/herdr/session/20261117-143052-餐厅点单系统.md`。这是格式示例。标题只取当前秘书的 recap，保留中文；文档内记录原始 recap、标题来源及时间时区。

**目前没有实现跨 Codex/Claude 的原生 recap 自动提取。** 能经本地验证读取时使用原生结果；否则秘书形成一行 recap、提炼中文简称，并记录 `secretary-generated`，不冒充宿主接口输出。后续可接入本地读取器，命名规则保持不变。

| 归档内容 | 规则 |
| --- | --- |
| 身份配置快照 | 保存用户实际确认的完整表格，含匿名身份，不只链接默认配置 |
| 显式会话台账 | 简单模式两行；复杂模式每个实际显式会话一行，包含真实 session ID、工具、角色、任务标题及 Herdr 位置 |
| 配置修订和交付引用 | 按需追加，不覆盖原确认记录；引用 spec、tickets、报告和提交 |

匿名执行只保留结果，不长期登记或复用 ID；这不代表所有工具都会物理删除原生历史。详细规则见 [归档说明](references/session-record.md)。

## Matt 工作流适配

[Matt 入口](references/matt.md) 从当前执行端的技能清单解析实际名称、namespace 和 `SKILL.md` 路径，再读取该安装中的正文与资源。本包不附带 Matt 的流程目录、源码压缩包或资源副本，也不固定一份 Matt 版本。

只需要当前步骤会用到的 Matt 技能，无须为本包另外安装一整套。文件型技能的相对资源仍从原技能目录读取；plugin 或宿主资源通过其原生接口加载。找不到入口、无法读取资源或来源不明确时，报告具体缺口并暂停依赖它的步骤。不会自动下载替代品或把缺少的 `implement-spec` 换成 `implement`。

派工同时传递已解析的技能来源、已知版本和当前阶段。另一工具或机器上的执行端先验证可读性，不能自行切换为不同的同名安装。Matt 的安装、更新和卸载由原有方式维护；本包只适配流程中实际的 agent 派工和协作边界。

主要衔接如下：

- 秘书进行整体设计；wayfinder 根据 map 的依赖与认领状态，自动为就绪的独立决策票开新 griller 面板、注入提示词。用户在子面板内完成 grilling；子会话写入确认结果并回报后，秘书核实、关面板、继续下一个票。
- 开发主流程的设计结果形成 spec 和 tickets 后，在进入实现处由秘书展示开工表。用户确认后才创建 PM，产品设计与实现上下文分离。只要求规划或非工程产物的 wayfinder，按自己的 destination 交付。
- PM 使用实际选定的实现流程。`implement` 与 `implement-spec` 保留各自的任务、TDD 和 review 节点；不会把所有票统一换成另一种实现流程。
- 新的实现任务使用新 worker；功能自测由 worker 完成，独立构建、编译、静态检查交 checker。需要基于 HEAD 的 review 时，可由 PM 在构建通过后先提交。
- research 由 searcher 直接执行；code-review 保留独立 Standards/Spec 视角；每次集成由 PM 授权临时 merger。所有执行端服从角色配置，不用随意的原生 subagent 替代。

Herdr 的 CLI 已提供创建面板、启动 agent 和投递 prompt 的控制面，本包不强制额外调度程序。主动回报和结果核验使用 [路由协议](references/routing.md)；能否在具体工具版本自动衔接，须在本地验证实际 Herdr 接口和父会话可寻址性。仅看到 `idle/done` 不算完成工单。

设计、研究、原型资料的 Git 操作由秘书负责；正式开发的提交、合并及服务重启由 PM 决策，merger 只执行明确授权的集成。职责由 skill 约束，没有系统级权限隔离或命令拦截。

## 升级、检查与卸载

本次改名使用新的技能目录和规则标记。已安装旧名称版本时，先备份自己的 `routing.json`，用旧包卸载旧入口，再按本文安装并迁回配置；新安装器不会自动搬迁旧目录。以下 `update` 命令用于已按新名称安装的版本。

```sh
npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills update \
  --agent codex,claude-code --project /path/to/project

npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills doctor \
  --agent codex --project /path/to/project

npx --package ./herdr-mattpocock-skills-0.4.0.tgz herdr-mattpocock-skills uninstall \
  --agent codex --project /path/to/project
```

`update` 安装正在运行的包版本，本身不联网获取或发布版本。安装器按校验值管理自身文件，冲突先报告；显式 `--force` 会先备份。普通卸载保留用户修改过的配置和额外文件，只移除自己的规则块。

**从 0.3.x 升级：** `update` 按原安装收据删除本包管理的旧 Matt 副本及其空目录，保留 `routing.json`、用户额外文件和独立安装的 Matt skills。原托管文件有修改时先报告冲突，沿用现有备份规则；升级后从 agent 环境加载 Matt。

**从 0.2.x 升级：** 现有 `routing.json` 按原样保留。使用 griller/merger 前参照新模板补齐；若仍有旧 `docsDir`，改为 `.agents/herdr/session`。安装器会提示缺失身份和旧默认目录，不搬移历史记录或静默替换用户选择。

`doctor` 只验证配置结构和命令可用性，不调用模型、验证登录或证明实际 model/effort/native 兼容，也无法代替执行端解析其 Matt 技能清单。`missingRoleBindings` 与 `nativeBindingsNeedVerification` 明示尚须处理的配置；即使结构检查通过，也须核对实际配置及当前步骤所需的外部技能。

## 工具适配边界

- Codex、Claude Code、Cursor 的显式会话使用 Herdr 对应集成；session ID 和恢复能力以本机版本为准。
- Codex 匿名入口为 `codex exec --ephemeral`；Claude Code 为 `claude -p --no-session-persistence`。
- DSH checker 用 `dsh --profile headless`，模型与 effort 经临时 YAML patch 指定。Herdr 文档未列原生 `dsh` kind，显式 DSH 需核实用户的交互 profile/启动器。
- Cursor 默认命令为 `agent`，部分环境使用 `cursor-agent`，配置实际可用命令。未核实的 effort 或无持久化开关不伪造。
- 原生子 agent 只用于明确配置且能力匹配的 searcher/merger；无法满足时，由秘书确认具体替代配置。

参数、来源及 recap 接口边界见 [工具适配](references/tools.md)。本包的安装测试不代表已完成各用户环境的 Herdr 与多种 agent 实机联调。

## 源码与打包

`.tgz` 包含源码、测试和技能资源：

```sh
mkdir herdr-mattpocock-skills-source
tar -xzf herdr-mattpocock-skills-0.4.0.tgz -C herdr-mattpocock-skills-source
cd herdr-mattpocock-skills-source/package
node bin/herdr-mattpocock-skills.mjs --help
npm test
npm run check
npm pack
```

没有运行时 npm 依赖。安装目标仅复制技能及其资源、配置，不把安装器和测试文件塞入宿主的技能上下文。

本包采用 [MIT 许可证](LICENSE)。安装示例使用本地 `.tgz`，不依赖公共 npm 发布；外部 Matt 技能的版本、更新和许可由其原安装维护。
