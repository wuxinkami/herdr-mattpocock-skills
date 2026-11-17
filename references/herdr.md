# Herdr 会话：派工、回报、关闭、故障

命令语法以本机 `herdr --help` 为准。`hms` 只封装下面这些确定性的步骤，不承载任何工作流逻辑。

## 显式面板（`hms spawn`）

脚本依次执行：

1. 检查 `HERDR_ENV=1`；不在 Herdr 内就报错退出。
2. 解析身份配置（有 `--snapshot` 就只用快照），生成交互命令参数。工具模板里有 `{sessionId}`（Claude Code）时，预先生成一个 UUID 作为原生 session ID。
3. 建面板：`place=tab` 时执行 `herdr tab create --workspace $HERDR_WORKSPACE_ID --cwd <cwd> --label <name> --no-focus`；否则执行 `herdr pane split --current --direction right --cwd <cwd> --no-focus`。面板 ID 从返回的 JSON 中读取。
4. `herdr pane run <pane> <命令>` 启动 CLI，轮询 `herdr agent get <pane>` 直到 Herdr 识别出 agent，再执行 `herdr agent rename <pane> <name>`。
5. 生成派工文件，内容为标准头（身份文件、快照、父会话地址、回报命令）加上调用方提供的正文；然后用 `herdr agent prompt <name> "请读取派工文件并按其执行：<路径>"` 投递。
6. 原生 session ID 依次取自 `agent get` 返回的 `agent_session.value`、第 2 步预设的 UUID；都没有则记为 `未取得`。面板 ID 永远不写进 session_id 一栏。
7. 带 `--record` 时，在台账追加一行。

如果 agent 启动时停在信任目录、登录这类对话框（状态为 `blocked`），脚本不会替用户点确认，只会提示用户去面板处理。用户处理完后运行 `hms prompt <name> --file <派工文件>` 补发。

Herdr 不识别的工具（没有对应的 kind 或集成）仍能在面板中运行，但 Herdr 拿不到它的状态和 session ID，脚本改用 `pane send-text` 投递派工，并在输出里标注 `recognized: false`。

## 子会话回报

派工头里已经写好完整的回报命令，子会话在**结果落盘之后**执行它：

```sh
node <skill>/scripts/hms.mjs notify --to <父面板> --inbox <inbox.jsonl> --task <id> --role <role> \
  --status completed|blocked|failed --result <结果路径或票据> --summary "<一句话>"
```

- 回报先追加到 inbox 文件（持久化），再投递给父会话。
- 父会话处于 `working` 或 `blocked` 时，脚本会等待（不会往审批对话框里打字），直到父会话空闲或超时（默认 30 分钟）。超时后结果仍保留在 inbox。
- 投递给父会话的文本格式：`HERDR_RESULT task=… status=… role=… result=… summary=…`。这是本技能自定的约定，不是 Herdr 内置事件。

## 父会话收到回报后

1. 先到结果所在处核实：票据状态、文件、提交。Herdr 显示的 `idle` / `done` 和回报消息本身都不算验收依据。
2. 回报可能重复，以结果为准：已经关闭或已经处理的任务不再派发。
3. 核实通过后执行 `hms close <name> --record <归档>`。仍在 `working` 的会话，脚本拒绝关闭；确认成果已经交接后，才可以加 `--force`。
4. 父会话在每次决定下一步之前，先查看一遍 inbox，补上可能漏收的回报。

## 匿名执行（`hms run`）

- 使用工具的 headless 命令，派工以“读取派工文件”的短 prompt 传入。stdout 写入 `--out`（默认 `<runDir>/out/…md`），stderr 写入同名的 `.stderr.log`。脚本的退出码就是 CLI 的退出码。
- 不开面板，不记录 session ID；报告文件保留。
- 需要并发的多个视角（如 code-review 的两轴、design-it-twice），在后台同时运行多个 `hms run`，等全部结束后按原流程汇总。
- `--lock <目录>` 用 mkdir 实现互斥锁。merger 用它保证同一 integration branch 同一时间只有一次合并，例如 `--lock "$(git rev-parse --git-common-dir)/hms-merge-<branch>.lock"`。
- 载体为 `native` 的身份由宿主自己的 subagent 执行，脚本不处理。前提是宿主工具与配置一致，且模型和思考等级可以设成相同值；做不到就改用 `background`，并告知 secretary。

## 核实参数

`hms argv <role> [--headless] [--snapshot …]` 打印将要执行的命令，不执行。使用 DeepSeek Harness 时，还可以运行 `dsh --profile <p> --patch <文件> --dump-config` 确认补丁生效。

## 故障与恢复

| 情况 | 处理 |
| --- | --- |
| 面板建好了但 agent 启动失败 | 脚本输出错误和面板 ID；查看 `herdr pane read <pane>` 找原因，修好后在同一面板重试，或 `herdr pane close` 后重新 spawn |
| `agent prompt` 超时或停滞 | 消息未必没送到。先 `herdr agent read <name>` 确认，再决定是否 `hms prompt`，不要盲目重发 |
| 子会话中途退出 | 台账里有 session ID 的，可以在新面板里用 `codex resume <id>` 或 `claude --resume <id>` 恢复；没有的，就新开会话，以派工文件和已落盘的结果作为输入 |
| 父会话重启或长时间离开 | 读 inbox 和归档台账，`hms ls --record <归档>` 对账：哪些面板还在、各是什么状态 |
| Herdr 服务重启 | 面板 ID 会失效；以台账中的 session ID 和落盘结果为准恢复，并在台账里更新面板位置 |
| 匿名执行失败 | 退出码非 0；stderr 日志和部分输出都保留在 `--out`。重跑还是放弃，由调用方按原流程决定 |
| 父会话结束后留下面板 | `hms ls` 列出台账中仍然存活的面板；用户决定后再 `hms close` |

只关闭自己创建的面板。不要停止 Herdr 服务，也不要关闭用户的其他面板。
