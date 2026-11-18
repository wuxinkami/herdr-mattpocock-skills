# herdr-mattpocock-skills

HMS 按职责选择工具、模型和思考等级，适配当前开发计划或 Matt 技能。[设计定稿](docs/产品文档/HMS.md)

```sh
npx herdr-mattpocock-skills install --target agents --project /path/to/project
```

安装包含同仓的两个技能。首次引用 HMS 时按表填写项目所用的 CLI、模型和思考等级（默认 `high`）。`$herdr-setup` 将选择写入 `.agents/herdr/routing.json`，也可随时调整项目默认值。

选宿主实际读取的技能目录，共享路径只安装一次。卸载共享副本时选择实际目录对应的目标。引用 `$herdr-mattpocock-skills` 默认简单模式，本轮要求团队、多 agent 或使用 wayfinder 时转团队。口头覆盖仅本轮生效。

[HMS](skills/herdr-mattpocock-skills/SKILL.md) · [herdr-setup](skills/herdr-setup/SKILL.md) · [Herdr 操作](skills/herdr-mattpocock-skills/AGENTS.md) · [角色职责](skills/herdr-mattpocock-skills/roles/)
