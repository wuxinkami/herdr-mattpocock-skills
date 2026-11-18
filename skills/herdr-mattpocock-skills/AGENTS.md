# Herdr 调度

- 显式派工用 `hms spawn ROLE --context C --task ID --prompt 正文`。脚本按进程祖先定位发起面板，必要时传已核对的 `--parent 地址`。开票级新实现者加 `--fresh --cwd 本票worktree`。在 worktree 里沿用本轮 context。查主项目配置用 `--project 主仓`。
- 用 `herdr agent prompt` 直接收发正文。后续派工用自己的地址，显式回报按随附的 `notify` 直回发起者。审批占用输入时最多等一分钟，超时保留结果与面板供重发。
- 匿名任务仅在同工具同模型且宿主能落实等级、目录和所需上下文时用 `hms native`，结果由宿主接收。团队中由宿主用 `record add --context C` 补登原生成员。其他情况用 `hms run`，输出直返。
- 简单模式主 agent 关闭前端，团队 PM 关闭已完成成员，秘书关闭 PM 和逐票 wayfinder。收到回报后等发送方结束回合，及时 `hms close 地址`。借用面板保留，明确移交才用 `--takeover`。
- 仅 HMS 团队模式创建 `.agents/herdr/<时间戳>-<recap标题>.md`。每轮一张四列表，登记本轮秘书、显式成员、匿名 CLI 和原生 subagent 的会话 ID、Agent 工具、实际模型、思考等级。升级前的调用不补记。ID 未取得、型号或等级未核实就照实填写。工作流产物归原处。
