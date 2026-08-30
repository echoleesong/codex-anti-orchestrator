# codex-anti-orchestrator

> **一个本地优先的 AI 协作编排器：Codex 负责审查，Antigravity 负责开发，GitHub PR 负责交接，最终由人决定是否合并。**

[English](README.md)

`codex-anti-orchestrator` 将 Codex App（MCP）、Antigravity CLI（`agy`）、GitHub Pull Request 和 OpenAI Codex CLI（`codex`）串成一个可审计的开发闭环。它适合这样的工作方式：你只提出目标，Anti 在隔离工作区中实现和修复，Codex 只读审查每轮变更；任何合并和部署始终由人明确决定。

## 它如何工作

```mermaid
flowchart LR
    U[你：提出目标] --> C[Codex App / MCP]
    C --> O[本地协调器]
    O --> W[仓库外隔离 Worktree]
    W --> A[Antigravity / agy 开发]
    A --> P[GitHub PR]
    P --> R[Codex CLI 只读审查]
    R -->|需修复| A
    R -->|审查通过| V[Anti 本地运行验证]
    V --> H[等待人工核验与合并]
```

核心原则：

- Anti 只在目标仓库外的隔离 Git worktree 中工作，不直接修改你的主工作区。
- Codex CLI 以只读沙箱审查差异，不提交代码、不推送、更不会合并 PR。
- 自动化流程可以创建、更新 PR 并迭代修复；**不会自动合并、部署、发布或绕过分支保护**。
- 监控页仅监听 `127.0.0.1`，只读展示任务、审查、CI 和本地验证状态。

## 前置条件

在每台运行协调器的机器上安装并登录：

1. Node.js 20 或更高版本（推荐 Node.js 24+）
2. Git 2.30+，目标仓库有 GitHub `origin` 远程地址
3. [GitHub CLI](https://cli.github.com/)：`gh auth status`
4. Antigravity CLI：`agy --version`
5. OpenAI Codex CLI：`codex --version`

克隆并安装依赖：

```bash
git clone https://github.com/example-owner/example-repo.git
cd codex-anti-orchestrator
npm install
npm run build
```

可先运行只读诊断，确认依赖、登录状态和目标仓库条件：

```bash
npm run doctor
# 脚本使用时可取得纯 JSON 输出
npm run doctor -- --json
```

## 首次使用：确认允许目录

“允许目录”是协调器可以作为**目标项目**访问的本地目录树，例如 `/Users/alice/code` 或 `/Users/alice/projects`。它是一道安全边界：只有该目录下的仓库可以创建任务；越界路径和通过符号链接逃逸的路径都会被拒绝。这样可避免任务路径出错或 AI 操作失控时触及其他仓库、个人文件或系统目录。

每台机器初始都没有默认允许目录。首次使用前，选择一个尽量窄、只包含待协作项目的父目录，然后明确确认：

```bash
npx tsx src/cli.ts configure --allowed-base /absolute/path/to/projects --confirm
```

配置会以 canonical path 和确认时间保存在本机：

```text
~/.codex-anti-orchestrator/allowed-base.json
```

如设置了 `CODEX_ORCHESTRATOR_STATE_DIR`，则保存到该状态目录。文件系统根目录 `/` 和整个 home 目录不能作为允许目录。换一台机器时需要重新确认；想更换允许目录时，再运行一次上述命令即可。

通过 MCP 第一次创建任务而尚未配置时，协调器会停止操作并返回建议的项目父目录。Codex 应先将该目录展示给你并询问确认；只有你明确同意，才会调用 `orchestrator_configure_allowed_base` 保存配置。

## 命令行使用

```bash
# 创建任务：会先验证仓库干净度、Git 锁文件和允许目录，并在仓库外创建 worktree
npx tsx src/cli.ts create \
  --repo /absolute/path/to/projects/my-project \
  --prompt "实现用户登录功能，并添加测试"

# 运行 Anti 开发、PR 创建、Codex 审查和自动修复循环
npx tsx src/cli.ts run <taskId>

# 查看单个任务，或列出全部任务
npx tsx src/cli.ts status <taskId>
npx tsx src/cli.ts status --all

# 提供额外修复指引后恢复任务
npx tsx src/cli.ts resume <taskId> --guidance "修复会话处理中的空指针"

# 以已知风险人工放行（不会变成 clean approval，也不会自动合并）
npx tsx src/cli.ts resume <taskId> --override

# 停止任务；隔离 worktree 会保留，便于检查
npx tsx src/cli.ts cancel <taskId> --reason "停止此任务"
```

## 本机监控页

运行以下命令可启动只读监控页：

```bash
npx tsx src/cli.ts monitor
# 或指定端口
npx tsx src/cli.ts monitor --port 4390
```

页面只监听 `http://127.0.0.1:<port>`，每三秒刷新，展示任务状态流转、PR 链接、测试与 CI 观察结果、Codex 人工核验清单、Anti 的 localhost 验证证据，以及经过脱敏的事件流。

任意 MCP 工具首次被调用时，也会自动启动同一只读监控页并在本机浏览器打开。默认优先使用 `http://127.0.0.1:4390`；端口被占用时会安全地选择下一个可用本机端口。

## 配置 Codex Desktop MCP

先构建项目：

```bash
npm run build
```

在 Codex Desktop 的 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.codex-anti-orchestrator]
command = "node"
args = ["/absolute/path/to/codex-anti-orchestrator/bin/mcp.js"]
cwd = "/absolute/path/to/codex-anti-orchestrator"
```

将两处 `/absolute/path/to/codex-anti-orchestrator` 替换为本机的真实仓库绝对路径，并重启 Codex Desktop。

MCP 暴露的工具只有：

1. `orchestrator_configure_allowed_base`：在你明确确认后保存允许目录。
2. `orchestrator_create_task`：创建隔离任务并做安全预检。
3. `orchestrator_run_task`：执行开发、PR 和审查循环。
4. `orchestrator_get_task_status`：读取任务状态和诊断。
5. `orchestrator_list_tasks`：列出本机已记录任务。
6. `orchestrator_resume_task`：从需人工决策或失败状态恢复，并附加修复指引。
7. `orchestrator_cancel_task`：中止任务并保留 worktree。

MCP 不提供风险放行、任意命令执行、合并、自动合并、部署、发布或工作流触发工具。

## 安全与人工验收

任务完成不等于 PR 已获准合并。只有以下条件都满足，任务才会进入 `AWAITING_HUMAN_APPROVAL`：

1. 本地自动化测试通过。
2. GitHub PR CI 全部通过。
3. Codex 的只读审查结论为 `APPROVE`，且没有阻断项。
4. Anti 已启动当前项目的本地开发环境，按 Codex 提供的核验清单完成验证，并留下结构化证据。

此时系统停止自动化操作，保留 worktree，由你在 GitHub 和本机运行态中最终核验并手动合并。若仍有风险或修复轮数耗尽，任务进入 `NEEDS_USER_DECISION`；即使你以 `--override` 继续，也只会进入 `AWAITING_HUMAN_OVERRIDE`，永远不会被自动视为干净可合并。

## 开发与验证

```bash
npm run typecheck
npm test
npm run format:check
npm run build
```

更多细节：

- [安全模型与约束](docs/security.md)
- [状态机与失败处理](docs/state-machine.md)
