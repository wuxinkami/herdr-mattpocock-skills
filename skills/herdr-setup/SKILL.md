---
name: herdr-setup
description: 为 HMS 项目配置角色的 CLI、模型和思考等级。适用于首次设置、补填本轮需要的身份或按用户要求调整项目默认值。
---

# Herdr Setup

1. 运行 `node <本技能目录>/scripts/setup.mjs form`，把输出的项目路由表原样交给用户。已有身份带出保存的配置，缺少的身份留空。提示用户只填写需要补充的身份或明确要修改的字段，等答复后再保存。秘书沿用当前会话。新增身份的思考等级留空时用 `high`。
2. 列工具用 `tools`。选型需要区分参数、变体或 profile 时，只查该 CLI 的[参数参考](references/cli-options.md)和 `adapter CLI`。DSH 填 `provider/model`。工具默认值须由用户明确选 `default`。
3. 将用户确认的新增身份和变更字段以 JSON 送入同一脚本的 `apply`，如 `{"roles":{"spec-writer":{"tool":"claude","model":"用户填写的型号"}}}`。用户明确删除身份时传 `null`。项目专用变体、profile 或自定义 CLI 的启动参数填在 `tools`，格式见[模板](templates/routing.json)。

`apply` 将答复合并到项目 `.agents/herdr/routing.json`。重复提交相同的设置会复用已保存的配置。用 `--project DIR` 指定项目，保存后继续原 HMS 任务。
