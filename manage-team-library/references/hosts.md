# 宿主适配范围

`~` 指执行目标工具的本人主目录。默认仅处理本次指定宿主；为另一工具代装时，验收也必须在另一工具里完成。目录存在不证明产品支持，文件写入不证明自动触发。

| 宿主 | 用户级安装位置 | 当前边界 |
|---|---|---|
| Codex | `~/.agents/skills/manage-team-library` | 不同时向 `.codex/skills` 再装同名入口；新对话核实发现与调用 |
| Claude Code | `~/.claude/skills/manage-team-library` | 配置了 `CLAUDE_CONFIG_DIR` 时采用该配置根 |
| WorkBuddy | `~/.workbuddy/skills/manage-team-library` | 尊重 `WORKBUDDY_CONFIG_DIR`；当前锁定 Core 的基线为 5.3.13，仅同步用户 Skill，不能宣称同步全局规则或专门角色 |
| Qwen | `~/.qwen/skills/manage-team-library` | 团队配置须支持对应资源通道 |
| DSH | `~/.dsh/skills/manage-team-library` | 尊重 `DSH_HOME`；DeepSeek Harness，仅锁定 Core 已验证的 0.1.1-rc.1；不是豆包办公 |
| 豆包办公 | 尚未确定受支持的用户技能入口 | 当前不提供自动目录写入。须核实实际版本的官方导入与持久执行能力后适配；不能修改内置技能目录 |

Codex/Claude Code 的目录有官方文档；其他产品版本变化时应重新实测，不扩大现有验证结论。当前脚本遇到不支持的宿主会在授权与写入前停止，不创建一个看起来合理的路径。

产品支持包导入而非目录扫描时，使用官方导入能力并检查是否启用；不能凭一份第三方目录截图认为已支持。权限或环境不能访问本机时，明确交付的是包或说明，不能称已接入。

参考：[Codex](https://learn.chatgpt.com/docs/build-skills)、[Claude Code](https://code.claude.com/docs/en/skills)、[WorkBuddy](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)。
