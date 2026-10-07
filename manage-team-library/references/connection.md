# 连接与安装

以下命令中的脚本路径取自本技能的实际目录；仓库与工作目录取自本次请求。操作同一目标时按状态跳过已完成步骤，不重复登录、安装或邀请。

## 先取得外置助手

从发布页下载明确版本的完整 ZIP，核对同一发布中的 SHA256 后解压。公开助手在公司私有仓库授权之前即可取得。先读取本 Skill 与当前步骤的说明，再执行包内脚本；不用 gh 下载首次安装包。

默认安装到当前宿主的用户级目录，路径见 hosts.md。若原入口仍由 TeamAI 管理，直接从下载目录执行下面的 connect；它先正常同步移除原入口，再安装外置包，不改内部清单。失败时保留下载目录，修复原因后重跑。原入口的个人修改或运行数据可能阻止移除，先妥善保存和整理，不以迁移为由删除。

## 必要环境

先用宿主命令能力检查 `git --version`、`gh --version`、`node --version`、`npm --version`。需要 Node.js 22+、npm 10+、Git 和 GitHub CLI；不安装无关业务依赖。仅有浏览器聊天或不能持久写入本机时，先说明能力缺口，不在临时容器冒充安装成功。

- Windows：优先使用已有 WinGet，为缺失项安装官方 `Git.Git`、`GitHub.cli`、`OpenJS.NodeJS.LTS`，先查询并固定本次选择的版本，再执行安装。没有 WinGet 时使用这些产品的官方安装包。不降低 PowerShell 全局执行策略；npm 被 `.ps1` 拦截时用 `npm.cmd`。
- macOS：复用已有运行环境；有 Homebrew 时只安装缺少的 `git`、`gh`、受支持的 Node LTS。没有 Homebrew 时，优先官方 Node/gh 安装包及系统 Git 安装流程，不为一个助手默认再装包管理器。需要系统确认时让用户确认，回来重新探测 PATH。
- Linux：采用当前发行版受支持的官方安装方式，不把其他发行版的命令照搬过来。

安装来源：[Git](https://git-scm.com/downloads)、[Node.js](https://nodejs.org/en/download)、[GitHub CLI](https://github.com/cli/cli#installation)。固定版本是本次实际下载的版本，不让模型凭记忆猜最新版。授权范围不够时停在所需动作，不扩大权限。

Node 就绪后运行 `node scripts/team-library.mjs doctor`。只有本次需要的项都就绪才继续。

## GitHub 与邀请

先用 `gh auth status --hostname github.com` 检查本人已有登录。未授权时运行：

```text
gh auth login --hostname github.com --web --git-protocol https
```

浏览器登录不等于 gh 授权。由用户在官方页面核对账号、完成授权或双重验证，Agent 接续后续步骤。不提取 Cookie、不输出令牌、不复制他人登录。

```text
node scripts/team-library.mjs access --repo OWNER/REPO
```

`accessible`：已有权限，继续。`invitation-pending`：用户已授权加入该仓库时，加 `--accept-invitation` 再执行，只接受该仓库邀请。`invitation-required`：显示脚本核实的账号和仓库，交给负责人邀请；不声称已发送请求。网络或权限错误与“没有邀请”分别报告。组织邀请或组织单点登录要求按 GitHub 官方页面完成，不能冒用仓库邀请接口。

负责人收到明确账号后，用相同助手执行：

```text
node scripts/team-library.mjs invite --repo OWNER/REPO --user LOGIN
```

该命令核实管理员权限并给出准备状态。用户已授权邀请时加 `--apply`，默认为能提交改进的仓库协作者。已有成员或待接受邀请不会重复发送，也不会提高已有权限。GitHub 权限才是真实边界，Skill 不能授予自己权限。

## 连接与恢复

选择独立创作目录；已有同一仓库检出优先复用。不可使用宿主技能安装目录或 TeamAI 缓存作为创作目录。

```text
node scripts/team-library.mjs connect --repo OWNER/REPO --workspace ABSOLUTE_PATH --agent HOST --accept-invitation
```

脚本核对仓库与锁文件，必要时执行 `npm ci --ignore-scripts`，再用项目安装的 Core 初始化和同步；不会临时下载同名 CLI。已有相同团队继续同步；已连接另一团队或作用域时保留现状，不自动切换。初始化退出不等于成功，脚本会再检查实际绑定。

团队仍包含同名管理 Skill 时，负责人先采用外置入口的仓库配置并发布；普通成员不要擅自修改团队源码来绕过检查。创作目录停留在旧版本时，先检查其分支与本地改动，再正常获取正式版本，不能重置本地修改。

给已连接团队增加另一个宿主：先核对同一仓库、现有启用列表及指定宿主路径，沿用 Core 的交互式 `init`，保留已有宿主并明确追加目标。不要用 `--force` 处理其他团队或目录冲突。完成后重跑 connect 核验。需要确定性全自动接入时，优先在首次 init 明确目标宿主。

`RECOVERY_REQUIRED` 表示安装中断留下 `.previous` 目录：核对它的安装收据和内容；目标缺失时恢复原目录，再重跑安装。目标仍在时先验证哪份完整，不同时删除两份。损坏的 TeamAI 事务交由原 Core 恢复，不修改其内部记录。

最后在目标工具的新对话中要求使用“团队工具助手”读取该团队工具清单。核对实际加载的 Skill 路径和版本，再完成一次小任务；安装器不能替目标产品证明加载成功。
