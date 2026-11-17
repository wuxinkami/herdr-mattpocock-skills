# 工具适配

只在启动、核实配置或恢复显式会话时读取。下列接口核查截至 2026-11-17；以用户本机版本和帮助为准。安装器安装规则与配置，不负责启动 agent，也不证明运行环境已配置完成。

## 启动前

1. 从 `routing.json` 取得 `tools[tool].command` 参数数组、角色的模型和思考等级。不要把数组拼成未经转义的 shell 命令。
2. 核实可执行文件、`--help`、所选模型及其支持的思考等级；只读取所需配置，不输出凭据。`inherit/default` 表示读取实际配置，不是传给 CLI 的模型名。
3. 秘书把已核实的配置列入本轮开工确认表，取得用户确认并归档后才启动 PM。模型或等级不受支持时让用户选择，不能悄悄换工具或降低等级。
4. 使用确认的项目目录和规则。派工携带本轮有效配置，接收端自己的默认配置不得覆盖它。

## Herdr 显式面板

先检查 `herdr --help`、本机 agent/pane 命令帮助和 `herdr integration status`。使用原任务 workspace/tab，创建时保持用户焦点。

官方接口示例：

```sh
herdr workspace create --cwd /project --label project --no-focus
herdr pane split <pane-id> --direction right --no-focus
herdr agent start frontend --kind claude --pane <new-pane-id> -- <已确认的CLI参数>
herdr agent prompt frontend '<已正确转义的派工内容>'
herdr agent get frontend
```

workspace/tab/pane 创建返回 JSON，从返回值读取真实 ID。`agent start` 只启动已有空闲 shell pane 中的 agent，不创建布局。常见 kind 为 `codex`、`claude`、`cursor`；不得猜测未支持的 kind。

`agent prompt` 的完成等待不绑定某一业务任务；目标已忙碌时，其他轮次完成可能满足状态等待。核对派工任务及实际返回结果，不把 `idle/done` 当作验收结论。审批 UI 用明确的交互处理，不向未知焦点盲发文本。

子会话可用同一 `agent prompt` 向父 agent 回报，父地址和任务标识必须在派工时提供。`notification show` 只显示通知，不能代替 agent 输入。被阻塞时先检查实际 UI；超时或 `agent_prompt_stalled` 不代表输入一定未发送，重试前读取目标，避免重复任务。业务回报协议见 [路由约定](routing.md)。

原生会话引用来自返回的 `agent_session.value`，并保留 `kind` 的含义。字段缺失时标“未取得”，不能把 pane ID、PID 或自行生成的编号当 session ID。Codex、Claude、Cursor 的恢复依赖对应 Herdr 集成版本；本机未验证前不声称已能恢复。

工具使用自定义启动器或当前 Herdr 不支持其 kind 时，用已核实的 pane/shell 接口启动配置命令。先验证它确实提供所需交互能力；普通终端能执行命令不代表 Herdr 已识别 agent 状态及原生会话。

## 各工具参数

| 工具 | 模型与思考等级 | 匿名调用入口 |
| --- | --- | --- |
| Codex | `--model <id>`；`-c 'model_reasoning_effort="<level>"'` | `codex exec --ephemeral` |
| Claude Code | `--model <id>`；`--effort <level>` | `claude -p --no-session-persistence` |
| DeepSeek Harness | 使用临时 `--patch` 配置，见下一节 | `dsh --profile headless` |
| Cursor CLI | `--model <id>`；没有在本版文档中核实独立 effort 参数 | `agent -p` |

仅传工具和模型实际支持的参数。长派工内容优先通过该工具支持的 stdin 或文件输入交付。上述非交互入口不等于异步启动；调用方在后台执行并按原工作流收集结果，不开 Herdr 面板。

### Codex

`-p` 是 profile，不是 print。显式会话的 ID 可由 Herdr 集成报告；非交互 JSON 的 `thread.started.thread_id` 也提供原生引用。只对需要恢复的显式会话保存引用，匿名调用不把 JSON 中的 ID 写入台账。交互恢复使用 `codex resume <id>`。

### Claude Code

显式会话可由 `--session-id <UUID>` 指定，再核实启动成功，或读取 Herdr 已报告的真实 ID。恢复使用 `claude --resume <id>`。思考等级随模型变化，不使用跨工具共用的硬编码枚举。

### DeepSeek Harness

职责选择 DSH 时，开工前核实实际 provider、model 和 reasoning effort；`default` 沿用其有效配置。角色指定了模型或等级时，在临时 YAML 文件中覆盖相关字段，不修改用户全局 profile：

```yaml
- id: agent-default-model
  config:
    provider: <实际配置的provider-id>
    model: <实际可用的model-id>
    reasoningEffort: <该模型支持的等级>
```

```sh
dsh --profile headless --patch /absolute/checker-route.yml < /absolute/checker-prompt.txt
```

`--patch` 放在 app 参数之前；未覆盖的字段沿用用户有效 profile。不要使用未经核实的 `dsh -p`、`--model`、`--effort` 或 `--ephemeral`。若需要显式指定 provider，可在对应角色条目加入 `provider`，并将其纳入配置核实。

DSH headless 默认新建持久化原生会话；本技能的匿名约定是不登记、不恢复该 ID，不能宣称 DSH 自身不保存会话。结束码 0 只说明 agent 运行结束，checker 仍须返回构建或测试命令自己的退出码。

当前 Herdr 文档没有 `--kind dsh`；DSH 官方默认 profiles 也不等于开箱交互式终端聊天。将 DSH 配给显式 PM/worker 时，须先核实用户的自定义交互 profile/启动器。后台 checker 不依赖这一能力。

### Cursor

最新官方命令名为 `agent`，部分环境及 Herdr 恢复配置仍使用 `cursor-agent`。核实两者与本机 Herdr 的兼容关系，并把实际命令写入 `tools.cursor.command`。

`agent create-chat` 可以返回新 chat ID；使用 `agent --resume <id>` 恢复显式会话。未核实通用的独立 effort 或不持久化开关：不得伪造选项。匿名执行仅不登记或复用其 ID，模型档位与思考能力按本机工具支持确认。

## 原生子 agent 的适用边界

只有配置为 `native` 的 searcher/merger 可以走原生子 agent。先核实当前宿主的子会话配置，能否真正匹配所选工具、模型及 effort，再在秘书确认表中展开实际值。Claude 子 agent 的可选模型仍受 Claude 宿主约束；Codex 子 agent 也不能仅凭职责名称切换成另一个 CLI/provider。继承 PM 的 merger 继承本轮有效配置，不继承一个含糊的角色名。

原生调用不匹配时，提出具体的外部匿名执行配置，由秘书取得确认；不静默回退。原生会话也可能由宿主保存内部历史，“匿名”只保证本技能不登记或复用其 ID。

## 秘书 recap 标题

归档命名按 [记录规则](session-record.md)。当前包没有通用原生 recap 提取器，也不提供未经验证的 `codex recap` 或 `claude --recap` 命令。

- Codex app-server 的 `thread/read` 可按已知的秘书 thread ID 读取概况；已设置会话名时可能包含 `thread.name`。会话名不等于已验证的 recap 输出，不要扫描所有会话来猜“当前秘书”。
- Claude Code 的 `/recap` 是当前会话的一行摘要，和 `/rename` 的显示名称不同；自动 recap 不出现在非交互模式，不能据此假定 `claude -p` 支持原生 recap 导出。
- 没有经本机验证的读取器时，秘书在当前上下文形成 recap，提炼中文简称并记录来源；后续本地适配可替换标题输入环节。

## 官方依据

- [Herdr 自动化](https://herdr.dev/tui/docs/agent-automation/)；[CLI](https://herdr.dev/tui/docs/cli-reference/)；[会话恢复](https://herdr.dev/tui/docs/session-state/)；[Socket API](https://herdr.dev/tui/docs/socket-api/)。
- [Codex 非交互](https://learn.chatgpt.com/docs/non-interactive-mode)；[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
- [Codex 子 agent](https://learn.chatgpt.com/docs/agent-configuration/subagents)；[App Server](https://learn.chatgpt.com/docs/app-server)。
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)；[子 agent](https://code.claude.com/docs/en/sub-agents)；[交互与 recap](https://code.claude.com/docs/en/interactive-mode)；[命令](https://code.claude.com/docs/en/commands)。
- [DSH CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)；[headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)；[模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-default-model/README.md)。
- [Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)。
