---
name: herdr-setup
description: 为 HMS 项目配置身份的 CLI、模型、思考等级和默认附加技能。适用于首次设置、补填身份或保存用户明确要求的项目默认值。
---

# Herdr Setup

1. 运行 `node <本技能目录>/scripts/setup.mjs form "$roles"` 查看所选身份。多行用逗号分隔，单独 `form` 查看全表。秘书沿用当前会话。新增身份的思考等级留空时用 `high`。
2. 列工具用 `tools`。选型需要区分参数、变体或 profile 时，只查该 CLI 的[参数参考](references/cli-options.md)和 `adapter CLI`。DSH 填 `provider/model`。工具默认值须由用户明确选 `default`。
3. 将用户确认的配置以 JSON 送入同一脚本的 `apply`。`roles` 以实际身份名为键，每行可填写 `tool`、`model` 和 `effort`。只有用户明确要求保存项目默认技能时，才将指定名称写入该行的 `skills` 数组。可单独保存技能字段，空数组清除默认技能。本轮选择交由 HMS 的 `--set "${role}.skills=${skill_names}"` 处理。用户明确删除身份时传 `null`。项目专用变体、profile 或自定义 CLI 的启动参数填在 `tools`，格式见[模板](templates/routing.json)。

`apply` 将答复合并到项目 `.agents/herdr/routing.json`。重复提交相同的设置会复用已保存的配置。用 `--project DIR` 指定项目，保存后继续原 HMS 任务。
