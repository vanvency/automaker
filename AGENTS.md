# Agent 开发指南

本文件适用于整个 Automaker 仓库，供自动编码 Agent 执行功能开发、修复和维护时使用。更深目录如有 `AGENTS.md`，同时遵循对应目录约定；用户明确给出的任务范围和授权优先。

## 项目与入口

这是 Automaker 的 fork：npm workspaces 单仓库，提供 Web / Electron UI、任务看板、Git Worktree 隔离和多 Provider 执行，并集成 Jira、GitLab、Pi / LiteLLM、Herdr、预览与验收材料。

先阅读 [README 使用流程](README.md#中文使用流程)。按任务选择以下入口，不必通读整个仓库：

| 目录 / 文件                                                         | 职责                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/ui/src/components/views/`                                     | React 19 页面；看板主要在 `board-view/`。                                                                      |
| `apps/ui/src/routes/`、`hooks/`、`store/`                           | TanStack Router 路由、查询与交互逻辑、Zustand 状态。                                                           |
| `apps/ui/src/lib/electron.ts`、`http-api-client.ts`、`api-fetch.ts` | Web / Electron API 入口及认证请求封装。                                                                        |
| `apps/ui/src/main.ts`、`apps/ui/src/preload.ts`                     | Electron 主进程与桌面集成。                                                                                    |
| `apps/server/src/index.ts`                                          | Express 5 服务启动、路由和后台服务装配。                                                                       |
| `apps/server/src/routes/<模块>/`                                    | API 注册、参数验证与响应；具体处理器在 `routes/` 子目录。                                                      |
| `apps/server/src/services/`                                         | 业务逻辑、任务存储、执行、同步、交付、预览和会话。                                                             |
| `apps/server/src/providers/`                                        | Claude、Codex、Cursor、Gemini、Copilot、OpenCode、Pi 等执行适配。                                              |
| `libs/`                                                             | `types`、`platform`、`utils`、`prompts`、`model-resolver`、`dependency-resolver`、`git-utils`、`spec-parser`。 |
| `scripts/`                                                          | Jira Python worker、迁移与模型初始化脚本。                                                                     |
| `docs/`                                                             | 业务规则、接口约定和集成说明。                                                                                 |

典型调用链：页面 / hook → API 客户端 → 服务端 route → service / provider → 共享库与外部 CLI；结果经 HTTP / WebSocket 回到 UI。修改行为前沿实际调用链阅读实现，并用 `rg` 找到所有调用方。

## 工作方式

1. 执行 `git status --short`，确认当前分支、工作目录和已有修改。保留用户及其他任务的改动，不执行破坏性的 reset / clean，不覆盖无关文件。
2. 明确本次行为、验收标准和影响范围，阅读相邻实现及相关测试。修 bug 先定位共享根因，避免只在一个 UI 入口补丁式绕过。
3. 优先复用现有组件、工具函数、标准库和已安装依赖。只实现当前需求，不顺带重构，不新增备用架构或无关依赖。
4. 完成已授权的开发和本地验证。只有缺少必要信息、凭据或外部条件而无法推进时才报告阻塞；不要把可自行决定的实现细节反复交给用户确认。
5. 运行与改动直接相关的检查，最后查看 `git diff --check` 和本次 diff。交付说明包含改动、实际运行的检查、未验证项及原因；不能把未运行的测试写成通过。

## 环境与命令

使用 **Node.js 22.x（`>=22.0.0 <23.0.0`）和 npm**。根 `package-lock.json` 是 workspace 依赖锁；不要因局部遗留锁文件切换整个仓库到 pnpm / yarn。以下命令在仓库根目录运行：

```bash
npm ci                     # 干净环境按锁文件安装；已有可用依赖时无需重复安装
npm run build:packages     # 按依赖顺序构建共享包；改动 libs 后重新执行
npm run dev                # 交互式选择 Web / Electron
```

分开启动 Web 和 API 时，在两个终端分别执行 `npm run dev:web` 与 `npm run dev:server`；默认端口为 3007 / 3008。外部服务并非本地编码的必备条件；只有实际验证相应集成时才需要 Provider 认证、Herdr、LiteLLM、Jira CLI、GitLab 或 k3s。

| 改动范围           | 验证命令                                             |
| ------------------ | ---------------------------------------------------- |
| UI 类型 / lint     | `npm run typecheck`、`npm run lint`                  |
| 服务端编译 / lint  | `npm run build:server`、`npm run lint:server:errors` |
| 共享包编译         | `npm run build:packages`                             |
| 服务端单测         | `npm run test:server`                                |
| UI 单测            | `npx vitest run --project=ui`                        |
| 全部 Vitest 单测   | `npm run test:unit`                                  |
| Web 构建           | `npm run build`（不包含 API 构建）                   |
| Playwright E2E     | `npm test`                                           |
| 依赖锁检查         | `npm run lint:lockfile`                              |
| 本次 Markdown 格式 | `npx prettier --check README.md AGENTS.md`           |

先跑相关文件，必要时扩大到受影响模块。例如：

```bash
npm run test:server -- apps/server/tests/unit/services/execution-service.test.ts
npx vitest run --project=ui apps/ui/tests/unit/hooks/use-board-column-features.test.ts
python3 -m unittest discover -s scripts -p 'test_jira*.py'
```

根 Vitest 配置包含 `libs`、server 和 UI；`test:packages` 实际选择所有非 server 项目，也会包含 UI。`test:all` 仍是 Vitest，不包含 Playwright。UI E2E 在 `apps/ui/tests/**/*.spec.ts`，默认使用测试端口 3107 / 3108 和 mock Agent；首次运行需要安装 Playwright Chromium（`npx playwright install chromium`）。`npm test` 的 pretest 会清理测试服务并准备 fixtures，勿指向真实业务数据。

只改文档时检查内容、链接和格式即可。行为变更使用已有 Vitest / Playwright / Python unittest 补充最小回归检查，覆盖会失败的实际场景，不为本任务新增测试框架。仅格式化本次改动文件，避免执行会改写全仓库的 `npm run format`。

## 代码约定

- 共享类型和逻辑通过 `@automaker/*` 导入，禁止跨 workspace 相对引用 `libs/*/src`；新增共享导出时更新该包 `src/index.ts`，不引入循环依赖。
- UI 使用现有组件、Tailwind、TanStack Query 和 Zustand 模式。保留键盘操作、标签、焦点与错误反馈等可访问性能力。
- UI 调用后端优先复用现有 API 客户端；直接请求使用 `apiFetch` 等认证封装。新增 API 同步检查客户端类型、调用 hook、缓存刷新和事件订阅。
- 路由沿用相邻模块的 handler 工厂和依赖注入方式；业务规则放在对应 service，不在多个路由或组件重复实现。服务端使用 NodeNext，遵循已有相对导入的 `.js` 后缀。
- 复用 `@automaker/utils` 的日志 / 错误处理、`@automaker/platform` 的路径与进程工具、`@automaker/git-utils` 的 Git 能力。不要重新实现已有 helper。
- 保留 API / WebSocket 认证、项目路径验证和文件访问限制。外部输入必须验证；执行 CLI 使用参数数组，避免将请求字段拼入 shell。
- 数据更新通过现有 loader / service 和事件链完成，避免手工写 JSON 绕过状态迁移、锁、持久化和前端通知。涉及 schema 变更时考虑已有任务数据。

## 必须保留的业务边界

- **任务状态与 Jira 状态独立。** 普通同步不自动转换 Jira workflow 或合并 MR；同步不能覆盖 Agent 执行状态、人工决定和验收结果。
- **任务范围不可扩大。** 普通 Jira 同步以父任务及已有子任务为一张卡的交付范围；未拆分 Epic / Story 等待明确决策，不能自行创建子任务或重派发旧任务。
- **派发必须幂等。** 保留 claim、`executionRunId`、项目锁和失败恢复语义；超时或响应不确定时先查实际状态，不能盲目重发。
- **会话附着不等于任务执行。** Pi 任务经 Herdr；Reply / Conversation 复用任务身份。修复终端连接不能顺带重复派发提示或启动新的 Agent。
- **Done 不等于已合并。** Agent 创建 PR / MR 时使用 Draft。自动开发和修复不自行合并、切换 Jira 终态或宣布人工验收；产品中的 Complete 仅在用户检查预览并确认后执行。修改这段流程时保留版本校验、阻塞项和分步重试。
- **归档不删除交付。** 保留任务、会话、验收材料和代码；外部 Jira / MR 清理由单独流程处理。不能通过更改 `feature.json` 跳过归档和交付约束。
- **Worktree 不是系统沙箱。** 不修改无关项目或默认分支来代替任务 Worktree。释放 checkout 时保留既有干净状态、远端分支和同分支任务检查；重建保留会话对应路径。
- **证据必须真实。** 实际截图、原型图和测试结果分别标识；缺少运行条件报告 blocked / skipped，不伪造通过结果。

本地修复和测试可在任务授权内推进；提交、推送、创建 Draft PR / MR、部署及外部写入按用户授权执行。不能仅因工具具备能力就对真实 Jira、GitLab 或集群执行变更。

## 数据与保密

项目 `.automaker/` 保存任务、设置、上下文、预览和验收材料；服务端 `DATA_DIR` 保存全局设置、凭据及同步状态；Pi / Herdr 另有原生会话目录。不要将这些目录作为构建缓存删除。

不提交或输出 `.env`、`credentials.json`、API key、token、认证链接或私人会话。使用 `.env.example` 了解配置字段，测试使用临时目录与 mock，日志 / 截图也不得包含凭据。

## 按需阅读

- Jira：[同步设置与幂等规则](docs/jira-sync-settings.md)。
- Agent 执行：[Provider 架构](docs/server/providers.md)、[Herdr 会话](docs/herdr-session-architecture.md)。
- 交付：[交付进度](docs/task-delivery-progress.md)、[验收材料](docs/task-acceptance-evidence.md)、[Worktree 预览](docs/worktree-previews.md)。
- 任务治理：[归档](docs/task-archive.md)、[相似任务](docs/similar-tasks.md)。
- 代码组织：[路由模式](docs/server/route-organization.md)、[共享包](docs/llm-shared-packages.md)、[贡献指南](CONTRIBUTING.md)。

旧文档如与当前实现不一致，以相关 `package.json`、配置、代码和测试核实，不照搬旧版本号、命令说明或上游分支策略。
