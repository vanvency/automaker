<p align="center">
  <img src="apps/ui/public/automaker.svg" alt="Automaker：任务分支汇合" width="112" height="112" />
</p>

<h1 align="center">Automaker</h1>
<p align="center">从 Jira 需求到 Worktree 交付的 AI 开发工作台</p>

[English](README.md) | 简体中文

本项目是 [AutoMaker-Org/automaker](https://github.com/AutoMaker-Org/automaker) 的 fork，保留看板、Git Worktree、Agent 执行和桌面 / Web 界面，并围绕实际项目交付扩展了 **Jira 同步、Herdr 会话、Pi / LiteLLM、多仓库 MR、功能预览和验收材料**。

当前仓库：[vanvency/automaker](https://github.com/vanvency/automaker)。本文描述当前代码中的功能；外部 CLI、模型网关与预览集群需要按需配置。上游的维护状态不代表本 fork 的状态。

- [Fork 后的主要变化](#fork-后的主要变化)
- [工作流](#工作流)
- [快速开始](#快速开始)
- [配置集成](#配置集成)
- [运行与开发](#运行与开发)
- [架构与数据](#架构与数据)
- [文档导航](#文档导航)

## Fork 后的主要变化

| 方向            | 当前能力                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Work Board      | 按 Worktree 汇总任务与交付进度，提供卡片 / 表格视图、分支操作和功能预览入口。                                             |
| Task Kanban     | 按代码空间查看任务，展示 Jira 类型、版本、子任务范围、需求变化、交付信息和待处理问题。                                    |
| Jira 同步       | 项目设置内配置 JQL、标签、轮询、模型与派发容量；先预览变更，再同步或定时运行，保留同步记录。                              |
| 会话与 Reply    | Agent 页面展示 Herdr 工作区；Pi 任务执行、Reply 和 Conversation 共用任务 pane 与会话历史，支持终端断线后重新附着。        |
| 多 Agent / 模型 | 支持 Claude、Codex、Cursor、Gemini、Copilot、OpenCode 和 Pi；Pi / OpenCode 可发现 LiteLLM 模型，选择器区分 Agent 与模型。 |
| 交付与审查      | 展示关联仓库、Draft PR / MR 和差异；保留失败、冲突与中断状态，等待人工处理。完成操作可协调 GitLab 多仓库 MR 合并。        |
| 功能预览        | 为 Worktree 部署独立的 k3s 预览，提供 URL、重新部署、停止及测试地址注入。                                                 |
| 验收材料        | 任务卡展示原型与真实截图对照、验证步骤、被测代码版本和结果。                                                              |
| 任务治理        | 带原因归档与恢复；Similar Works 比较重叠需求，经确认后清理被覆盖任务及选定的 MR / Jira 状态。                             |

继承的能力包括计划审批、依赖图、上下文文件、Spec / Ideation、集成终端、主题与快捷键、GitHub Issues / PR 和 Electron 打包。

## 工作流

1. **导入或创建需求**：手动建卡，或在 Project Settings → Jira 同步中预览并导入匹配的任务。
2. **确认交付范围**：正常 Jira 同步将父任务及其已有子任务作为一张卡的交付范围；关联任务按 Epic 根任务归并代码空间。未拆分的 Epic / Story 等待 Jira 拆分或人工决策。
3. **执行与沟通**：选择 Agent / 模型，手动启动或按同步配置派发。在日志或 Conversation 中查看进度，通过 Reply 回答问题、补充需求或继续工作。
4. **检查交付**：查看代码差异、Draft PR / MR、部署预览和验收截图。需求变化与执行错误会保留在卡片上。
5. **验收与收尾**：人工核对后标记完成；涉及 GitLab MR 的 Complete 流程会检查合并条件并执行合并。无需继续的任务使用带原因归档，重叠需求通过 Similar Works 单独确认。

看板列为 **Backlog → In Progress → Needs Attention → Waiting Review → Done**。Needs Attention 汇总失败、冲突、中断等状态；它不是每个任务的必经步骤。Done 对应已验证任务，后续 Complete / 归档与“代码已合并”仍需分别核对。

Jira 状态与 Automaker 执行状态独立。普通同步不自动流转 Jira，也不自动合并 MR；交付回执或 Agent 自报通过不等于人工验收。Similar Works 的外部关闭操作需在预览后显式选择并确认。

## 快速开始

### 环境要求

- **Node.js 22.x**（`>=22.0.0 <23.0.0`）、npm、Git。
- 至少一个已安装并完成认证的 Agent。使用 Claude 以外的 Provider 无需安装 Claude CLI。
- 使用本 fork 的 **Pi 任务 / Reply / Conversation** 时，服务端需要 Pi、Herdr 和可访问的 LiteLLM 网关。
- Jira 同步另需 Python 3 和已登录的 Jira CLI；GitHub 操作使用 `gh`；k3s 预览另需 `kubectl` 和镜像构建工具。

```bash
git clone https://github.com/vanvency/automaker.git
cd automaker
npm install
npm run dev
```

交互启动器可选择 Web 或 Electron。默认 UI 为 `http://localhost:3007`，API 为 `http://localhost:3008`。打开项目后，在 Settings 中配置 Provider 与默认模型，在 Project Settings 中配置项目集成。

纯 Web 开发也可同时启动前后端：

```bash
npm run dev:full
```

## 配置集成

### Pi / LiteLLM 与 Herdr

确保 `pi` 和 `herdr` 在 **Automaker 服务端进程的 PATH** 中，或用 `HERDR_BIN` 指定 Herdr 路径。模型网关默认地址为 `http://127.0.0.1:4000/v1`：

```bash
export AUTOMAKER_LITELLM_BASE_URL=http://127.0.0.1:4000/v1
# 在服务端环境配置 LITELLM_MASTER_KEY，勿提交到仓库。
npm run init:pi-litellm -- --dry-run
npm run init:pi-litellm
# 如需使用 OpenCode 接入同一网关：
npm run init:opencode-litellm
```

Pi 模型写入 `~/.pi/agent/models.json`；OpenCode 模型写入 `~/.config/opencode/opencode.jsonc`。`auto`、`leader`、`worker` 是网关路由别名，网关必须实际配置相应路由。初始化脚本读取网关模型列表，不负责部署 LiteLLM。

模型标识例如 `pi:litellm/worker`、`opencode:litellm/worker`。设置页提供 Pi 安装状态与模型刷新；不同 Provider 的认证方式见 [Provider 文档](docs/server/providers.md)。

Herdr 的常规任务层级为 **项目 session → Worktree workspace → 任务 tab → Agent pane**。Pi 任务启动时会检查 Herdr、安装缺失的 Pi 集成并准备会话；Herdr 不可用会明确失败。非任务用途的 Pi 调用仍使用 CLI。详见 [Herdr 会话架构](docs/herdr-session-architecture.md)。

### Jira 与 GitLab

在 **Project Settings → Jira 同步** 中配置站点、项目、JQL、标签、模型、目标分支和 reviewer 映射。按“测试连接 → 预览匹配与变更 → 保存 → 立即同步 / 定时同步”接入。

服务端复用 Jira CLI 登录，浏览器不保存 Jira token。自动执行可以单独关闭，暂停同步不会终止已经运行的 Agent。旧 `jira-monitor` 安装可在设置页迁移接管，保留任务身份、状态和历史；不要同时运行新旧调度器。

GitLab 相关操作需要服务端配置 `GITLAB_TOKEN` 或 `GITLAB_TOKEN_FILE`，主机与项目配置一致。详见 [Jira 同步设置](docs/jira-sync-settings.md)、[旧 CLI monitor](docs/jira-monitor.md) 和 [相似任务清理](docs/similar-tasks.md)。

### 预览与验收

在项目主目录配置 `.automaker/preview.json`，显式选择开发集群 context 和专用 namespace；namespace 必须带 `automaker.dev/previews-enabled=true` 标签。Work Board 或任务看板可部署当前 Worktree 的磁盘内容，包括未提交改动；修改后需重新部署。

就绪预览的地址会通过 `AUTOMAKER_PREVIEW_URL` 注入 Worktree 测试。Agent 可写入 `.automaker/acceptance/<featureId>/manifest.json`，自动回填原型、真实截图和检查结果；截图被复制到任务目录保存。

详见 [Worktree 预览配置](docs/worktree-previews.md) 和 [验收材料格式](docs/task-acceptance-evidence.md)。预览隔离应用进程与路由；数据库、队列等依赖是否隔离由项目配置决定。

## 运行与开发

| 命令                                            | 用途                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `npm run dev`                                   | 交互启动 Web / Electron。                          |
| `npm run dev:full`                              | 构建共享包并同时启动 API、Web 开发服务。           |
| `npm run dev:web`                               | 仅启动 Web UI；需另行启动 API。                    |
| `npm run dev:server`                            | 构建共享包并启动 API 开发服务。                    |
| `npm run dev:electron`                          | Electron 开发模式。                                |
| `npm start`                                     | 启动器的生产模式（先构建）；桌面分发使用打包命令。 |
| `npm run build` / `npm run build:server`        | 分别构建 UI / API 及其共享包。                     |
| `npm run build:electron`                        | 打包桌面应用；也支持 `:mac`、`:win`、`:linux`。    |
| `npm run typecheck`                             | UI TypeScript 检查。                               |
| `npm run lint` / `npm run lint:server:errors`   | UI / 服务端 lint。                                 |
| `npm run test:unit`                             | Vitest 单元测试。                                  |
| `npm run test:server` / `npm run test:packages` | 服务端 / 共享包测试。                              |
| `npm test`                                      | Playwright 端到端测试。                            |

### Docker

```bash
docker compose up -d --build
```

现有 [Compose 配置](docker-compose.yml) 提供 UI、API 和持久化卷；项目目录与认证文件需通过本地 `docker-compose.override.yml` 挂载。Linux / WSL 下，将 `.env` 中的 `UID`、`GID` 设置为 `id -u`、`id -g` 的结果后再构建，避免挂载目录权限不匹配。

镜像不会自动配置本 fork 所需的全部外部集成；Pi / Herdr、Jira CLI、LiteLLM 连通性和 k3s 权限应在容器内分别准备。容器内的 `127.0.0.1` 指向容器自身。

### 常用环境变量

| 变量                                                | 用途                                       |
| --------------------------------------------------- | ------------------------------------------ |
| `AUTOMAKER_WEB_PORT` / `AUTOMAKER_SERVER_PORT`      | 启动器的 UI / API 端口，默认 3007 / 3008。 |
| `PORT`                                              | 直接启动 API 时的监听端口。                |
| `DATA_DIR`                                          | 服务端全局设置和运行状态目录。             |
| `AUTOMAKER_API_KEY`                                 | 服务端 API 认证密钥。                      |
| `ALLOWED_ROOT_DIRECTORY`                            | 限制文件操作的根目录。                     |
| `CORS_ORIGIN`                                       | 允许的跨域来源。                           |
| `HERDR_BIN`                                         | Herdr 可执行文件路径。                     |
| `AUTOMAKER_LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` | LiteLLM 网关与服务端凭据。                 |
| `JIRA_CLI_PATH` / `JIRA_CONFIG_FILE`                | Jira CLI 与站点配置。                      |
| `GITLAB_TOKEN` / `GITLAB_TOKEN_FILE`                | GitLab 服务端认证。                        |

Agent 会读写代码并执行命令。Git Worktree 隔离分支和工作目录，不提供操作系统沙箱；根据运行环境配置文件权限、认证及容器隔离。完整说明见 [DISCLAIMER.md](DISCLAIMER.md)。

Claude Provider 使用 Claude Agent SDK；其计费与交互式 Claude Code 可能不同，请查阅 [Anthropic 官方说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)。其他 Provider 按各自服务或网关配置认证和计费。

## 架构与数据

React 19、Vite 7、Electron 39、TypeScript、TanStack Router / Query、Zustand 和 Tailwind CSS 构成界面；Express 5、WebSocket 和 node-pty 提供 API、实时事件与终端。Jira worker 使用 Python，Herdr 通过本地 socket 控制 Agent 会话。

```text
automaker/
├── apps/ui/         # Web / Electron：Work Board、Task Kanban、会话与设置
├── apps/server/     # API、Agent 执行、Herdr、Jira、交付与预览服务
├── libs/            # types、utils、prompts、platform、model-resolver、
│                    # dependency-resolver、git-utils、spec-parser
├── scripts/         # 启动、模型初始化、Jira worker、迁移与审计工具
└── docs/            # 功能配置与架构说明
```

Automaker 的主要状态保存在文件中，无需为应用配置数据库：

| 位置                                             | 内容                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| `<project>/.automaker/features/<id>/`            | 任务 JSON、Agent 输出、附件与验收截图。              |
| `<project>/.automaker/settings.json`             | 项目设置与非敏感 Jira 同步配置。                     |
| `<project>/.automaker/context/`                  | Agent 上下文文件。                                   |
| `<project>/.automaker/preview.json`、`previews/` | 预览配置及运行状态。                                 |
| `DATA_DIR`                                       | 全局设置、凭据及服务运行状态，按服务端启动配置解析。 |
| `DATA_DIR/jira-sync/`                            | 按项目隔离的同步状态、worker 配置与记录。            |
| `DATA_DIR/task-consolidation/`                   | 相似任务清理计划与执行记录。                         |
| `~/.pi/agent/`、Herdr 配置目录                   | Pi 原生会话、模型配置及 Herdr session 信息。         |

备份时同时考虑项目 `.automaker/`、服务端 `DATA_DIR` 与 Provider 会话目录；凭据、截图和本地配置不应提交到公开仓库。

## 文档导航

| 文档                                                 | 内容                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| [Jira 同步设置](docs/jira-sync-settings.md)          | 页面配置、迁移、幂等与运行记录。           |
| [Jira monitor](docs/jira-monitor.md)                 | CLI 工作流与高级层级导入。                 |
| [Herdr 会话架构](docs/herdr-session-architecture.md) | 项目 / Worktree / 任务映射与会话生命周期。 |
| [Provider 架构](docs/server/providers.md)            | 多 Agent 路由、模型、认证和会话。          |
| [Worktree 功能预览](docs/worktree-previews.md)       | k3s、镜像构建、预览 URL 与测试。           |
| [任务验收材料](docs/task-acceptance-evidence.md)     | manifest、截图与自动回填。                 |
| [任务归档](docs/task-archive.md)                     | 归档原因、重复引用与恢复。                 |
| [相似任务](docs/similar-tasks.md)                    | 需求对照、覆盖判断与外部资源清理。         |
| [Git 交付流程](docs/checkout-branch-pr.md)           | 分支、提交、Draft PR 与评审。              |
| [终端](docs/terminal.md)                             | PTY、WebSocket 与终端配置。                |
| [共享包](docs/llm-shared-packages.md)                | Monorepo 公共模块。                        |
| [贡献指南](CONTRIBUTING.md)                          | 开发约定；向本 fork 提交时使用本仓库地址。 |

## 来源与许可证

感谢 [AutoMaker 原项目及贡献者](https://github.com/AutoMaker-Org/automaker)。本 fork 延续 **MIT License**，保留原有版权与许可，详见 [LICENSE](LICENSE)。

项目图标以分支节点与汇合路径表达任务并行执行和交付收敛，SVG 源文件为 [automaker.svg](apps/ui/public/automaker.svg)，用于文档、应用入口和桌面图标。
