---
name: herdr-setup
description: 仅在 HMS 发现本项目路由尚未激活，或用户要求配置 HMS 项目默认值时，填写角色的 CLI、模型和思考等级。
---

# Herdr Setup

1. 运行 `node <本技能目录>/scripts/setup.mjs form`，把表格交给用户。只填用到的身份，简单模式可只填前端。主会话沿用自身设置，其余等级默认 `high`。
2. 列工具用 `tools`。选型需要区分参数、变体或 profile 时，只查该 CLI 的[参数参考](references/cli-options.md)和 `adapter CLI`。DSH 填 `provider/model`。工具默认值须由用户明确选 `default`。
3. 将答复以 JSON 送入同一脚本的 `apply`，如 `{"roles":{"frontend":{"tool":"claude","model":"用户填写的型号"}}}`。已有配置只传变更，删除身份传 `null`。项目专用变体、profile 或自定义 CLI 的启动参数填在 `tools`，格式见[模板](templates/routing.json)。

`apply` 只写项目 `.agents/herdr/routing.json`，随后继续原 HMS 任务。用 `--project DIR` 指定项目。
