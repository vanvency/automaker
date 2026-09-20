# Herdr 会话架构

本文描述当前 fork 的实现。Agent 页面已切换为 Herdr 工作区预览；Pi 任务执行、
Reply、流水线步骤与 Conversation 复用同一个任务会话。旧 Pi Web / OpenCode Web
接口仍保留，但不是 Pi 任务缺少 Herdr 时的自动降级执行路径。

## 会话层级

```text
项目 → Herdr session
└── Worktree → workspace / space
    ├── 任务 A → tab
    │   └── Pi 交互会话 → pane
    └── 任务 B → tab
        ├── leader → pane
        └── worker → pane
```

Session 名由 `buildProjectSessionName(projectPath)` 从项目目录名生成 slug；
没有项目上下文时使用 `automaker`。项目目录同名时需注意 session 名可能相同，
当前命名不是项目绝对路径的唯一哈希。

任务持久化 `herdrWorkspaceId`、`herdrTabId` 和 `providerSessionId`，恢复时优先使用
这些身份，不仅凭任务标题猜测。旧布局中没有 tab ID 的卡片仍兼容以 workspace
作为任务空间。实验性调度路径与旧任务可能保留各自布局。

## 运行条件

- 服务端能执行 `herdr` 与 `pi`；Herdr 支持 `HERDR_BIN` / `HERDR_BIN_PATH` 覆盖。
- Pi 配置 LiteLLM 模型与认证，见 [Provider 文档](server/providers.md)。
- Herdr 的 Pi 集成可用；任务启动的 bootstrap 路径会安装缺失集成并准备项目 session。
- 常规 Pi 任务缺少 Herdr 或 Pi 集成时直接报错，不另起隐藏的 `pi --print` 进程。
- Windows 的 Herdr 客户端与本地 socket 兼容性需要在目标环境验证。

## 控制与附着

```text
Task Kanban / Reply
    → AutoMode facade → HerdrFeaturePiProvider
    → HerdrTaskService → HerdrControlClient → Herdr socket → Pi pane
                                                ↓
                                    Pi JSONL → 日志 / transcript

Agent / Conversation
    → HerdrService → TerminalService PTY → herdr --session <name>
    → /api/terminal/ws → 浏览器 xterm.js
```

| 模块                                          | 职责                                               |
| --------------------------------------------- | -------------------------------------------------- |
| `herdr-client.ts`                             | 本地 socket JSON-RPC、请求超时和事件订阅。         |
| `herdr-bootstrap.ts`                          | 检查可执行文件、版本、Pi 集成与项目 session。      |
| `herdr-task-service.ts`                       | workspace、tab、pane 的创建、恢复与 Agent 控制。   |
| `herdr-feature-pi-provider.ts`                | 将常规 Pi 任务、Reply 和流水线接入交互 pane。      |
| `herdr-monitor.ts`                            | 订阅 Herdr 状态事件，缓存并向应用发布状态。        |
| `herdr-transcript.ts` / `pi-session-store.ts` | 读取 Pi 原生 JSONL 历史，避免只截取 TUI 可见屏幕。 |
| `herdr-service.ts` / `terminal-service.ts`    | 创建与复用浏览器附着 PTY。                         |
| `herdr-scheduler.ts`                          | 实验性 leader 规划、worker 执行调度。              |

以上服务位于 `apps/server/src/services/`；Pi Provider 位于
`apps/server/src/providers/`。浏览器页面的 xterm.js 资源由服务端托管，无需 CDN。

## Pi 执行与 Reply

`AutoMode` facade 在识别到 Pi Provider 后使用 `HerdrFeaturePiProvider`：

1. 检查运行条件并刷新模型配置，解析任务的实际 worktree。
2. 恢复任务 pane 与 Pi session，优先使用 Herdr 报告的精确 JSONL 路径。
3. 空闲时可重启该任务的 Pi 进程以加载最新历史和模型设置，保留原 pane / tab。
4. 只向 `idle` / `done` 会话提交；忙碌会话拒绝重复派发。
5. 读取本轮新增 JSONL 消息，更新任务输出及 Provider session 身份。
6. 停止任务向对应 pane 发送 Escape；完成后保留会话供回看和继续对话。

非任务用途的 Pi 调用仍由 `PiProvider` 通过 CLI JSON 模式执行。
Leader / worker 调度入口 `/api/features/herdr-dispatch` 已实现，但仍为实验性路径，
不意味着每个普通任务都会自动拆分或派发多个 Agent。

## 断线、重启与身份

网页地址中的 `session=term-...` 是 Automaker PTY 连接 ID，不是 Pi session ID。
服务端重启时这个 ID 可能失效，Herdr 和 Pi 原生会话可以继续保留。

Conversation 收到终端退出或 WebSocket 4004 时调用 `/api/herdr/reattach`，
重新附着原 Herdr session 并更新地址。该接口不启动 / 重启 Pi，也不发送任务提示。
新链接显式携带 `projectPath`；旧链接仅有 `dir` 时通过 Git common-dir 恢复项目身份。
登录凭据失效与终端失效分别处理，认证失败需要重新登录。

附着 PTY 按 session 复用，因此多个浏览器入口可能共享焦点、输入及终端尺寸，
不提供每个浏览器独立的 Herdr 布局。Automaker 退出时清理附着连接与 Herdr 会话的
存活是两件事，不能把 PTY 断开当作 Agent 已停止。

## API

这些入口均复用 Automaker 认证；涉及项目路径时还需通过路径校验。

| 接口                                | 用途                                   |
| ----------------------------------- | -------------------------------------- |
| `GET /api/herdr/status`             | 控制面与集成就绪状态。                 |
| `POST /api/herdr/preview`           | 为应用内 Agent 页面准备工作区预览。    |
| `POST /api/features/herdr-web`      | 解析任务并返回 Conversation 附着地址。 |
| `POST /api/herdr/reattach`          | 失效 PTY 的重新附着。                  |
| `GET /api/herdr/view`               | xterm.js 终端页面。                    |
| `GET /api/herdr/assets/:file`       | 白名单中的终端静态资源。               |
| `GET /api/features/herdr-task`      | 任务的 Agent / pane 状态。             |
| `POST /api/features/herdr-dispatch` | 实验性 leader / worker 调度。          |

服务端不将 Herdr socket 直接暴露给浏览器；终端仍使用现有 WebSocket 认证与终端
密码流程。附着时剥离调用者的 `HERDR_*` pane 控制变量，避免嵌套会话或连接到错误
socket。深链接凭据由页面认证帮助函数处理，不应将完整会话 URL 公开分享。

## 验证入口

```bash
npx vitest run --project=server \
  apps/server/tests/unit/providers/herdr-feature-pi-provider.test.ts \
  apps/server/tests/unit/services/herdr-service.test.ts \
  apps/server/tests/unit/routes/herdr-reattach.test.ts
```

其他控制面与调度测试在 `apps/server/tests/unit/services/herdr-*.test.ts`；
UI 预览测试在 `apps/ui/tests/unit/components/agent-view-herdr-preview.test.tsx`，
端到端入口为 `apps/ui/tests/agent/herdr-preview.spec.ts`。
