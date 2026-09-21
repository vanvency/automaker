import { Link } from '@tanstack/react-router';
import { Activity, ArrowRight, GitBranch, Import, MessageSquare } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';

const lanes = [
  {
    title: 'Backlog',
    label: '待开发',
    color: 'bg-[var(--status-backlog)]',
    description: '导入或手工创建任务，确认范围、模型与依赖，再手动启动或等待自动派发。',
    action: '你来做：明确验收标准',
  },
  {
    title: 'In Progress',
    label: '开发中',
    color: 'bg-[var(--status-in-progress)]',
    description: 'Agent 在任务对应的 Worktree 中开发和验证。启用计划审批时，先审阅计划。',
    action: '你来做：跟进日志，回答问题',
  },
  {
    title: 'Needs Attention',
    label: '需要处理',
    color: 'bg-[var(--status-error)]',
    description: '执行失败、冲突或中断时集中展示。先查看原因，再修复环境或补充指令后继续。',
    action: '异常分支：并非每个任务都经过',
  },
  {
    title: 'Waiting Review',
    label: '等待验收',
    color: 'bg-[var(--status-waiting)]',
    description: '检查代码差异、测试、预览和真实截图。不符合要求时反馈修改，通过后 Verify。',
    action: '你来做：实际验收交付',
  },
  {
    title: 'Done',
    label: '已验证',
    color: 'bg-[var(--status-success)]',
    description: '已在 Automaker 内验证。点击 Complete，检查交付预览并确认，才能推进最终交付。',
    action: '你来做：确认合并与完成',
  },
];

export function HomeView() {
  const currentProject = useAppStore((state) => state.currentProject);

  return (
    <div className="flex-1 overflow-y-auto content-bg" data-testid="home-view" lang="zh-CN">
      <div className="mx-auto max-w-6xl space-y-10 px-5 py-10 sm:px-10">
        <header className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 sm:p-10">
          <div
            className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="mb-6 flex items-center gap-3 text-sm font-semibold">
              <img src="/automaker.svg" alt="" className="h-9 w-9" />
              Automaker · 使用指南
            </div>
            <h1 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              从 Jira 需求，到可验收的交付
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
              把需求带入看板，让 Agent 在独立的代码空间中开发。
              你可以随时查看进度、参与决策、反馈修改，并在验收后确认交付。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/dashboard" className={buttonVariants()}>
                打开或创建项目 <ArrowRight aria-hidden="true" />
              </Link>
              {currentProject && (
                <Link to="/board" className={buttonVariants({ variant: 'outline' })}>
                  进入任务看板
                </Link>
              )}
              <Link to="/running-agents" className={buttonVariants({ variant: 'outline' })}>
                查看运行中的 Agent
              </Link>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {currentProject
                ? `当前项目：${currentProject.name}，下方项目入口均作用于该项目。`
                : '先打开项目，再配置 Jira 同步、模型与项目上下文。'}
            </p>
          </div>
        </header>

        <nav aria-label="首页章节" className="flex flex-wrap gap-2">
          {[
            ['import', '01 · 导入 Jira'],
            ['scope', '02 · 确认拆分'],
            ['lanes', '03 · 泳道推进'],
            ['interact', '04 · 监控与交互'],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="grid gap-6 lg:grid-cols-2">
          <section
            id="import"
            aria-labelledby="import-title"
            className="scroll-mt-6 rounded-xl border border-border bg-card p-6"
          >
            <Import className="mb-4 h-6 w-6 text-primary" aria-hidden="true" />
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">
              01 / IMPORT
            </p>
            <h2 id="import-title" className="mt-2 text-xl font-semibold">
              如何导入 Jira
            </h2>
            <ol className="mt-5 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
              <li>
                在服务端安装并登录 Jira CLI；打开项目，在 Project Settings → Jira Sync
                配置站点与项目。
              </li>
              <li>用 JQL 和标签选择需求，设置 Agent / 模型、目标分支、轮询间隔与派发容量。</li>
              <li>先「测试连接」，再「预览匹配与变更」，检查将创建、更新、跳过或阻塞的任务。</li>
              <li>保存后「立即同步」。确认导入结果，再按需启用定时同步和自动执行。</li>
            </ol>
            <p className="mt-4 rounded-lg bg-muted/50 p-3 text-sm leading-6">
              关闭自动执行仍会导入卡片。暂停同步不会停止已运行的 Agent； 普通同步不会自动关闭 Jira
              或合并 MR。
            </p>
            {currentProject ? (
              <Link
                to="/project-settings"
                search={{ section: 'jira' }}
                className={buttonVariants({ variant: 'link', className: 'mt-3 px-0' })}
              >
                配置 Jira 同步 <ArrowRight aria-hidden="true" />
              </Link>
            ) : (
              <Link
                to="/dashboard"
                className={buttonVariants({ variant: 'link', className: 'mt-3 px-0' })}
              >
                先选择项目 <ArrowRight aria-hidden="true" />
              </Link>
            )}
          </section>

          <section
            id="scope"
            aria-labelledby="scope-title"
            className="scroll-mt-6 rounded-xl border border-border bg-card p-6"
          >
            <GitBranch className="mb-4 h-6 w-6 text-primary" aria-hidden="true" />
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">
              02 / SCOPE
            </p>
            <h2 id="scope-title" className="mt-2 text-xl font-semibold">
              如何拆分任务
            </h2>
            <p className="mt-5 text-sm leading-6 text-muted-foreground">
              先确定交付边界，再让 Agent 开发。优先在 Jira
              中把大需求拆成可验证的子任务，写清目标、依赖和验收标准。
            </p>
            <div className="my-5 rounded-lg border border-dashed border-border p-4 text-sm leading-7">
              <p className="font-medium">示例：Story「增加订单导出」</p>
              <ul className="mt-2 list-disc pl-5 text-muted-foreground">
                <li>子任务：导出接口与权限检查</li>
                <li>子任务：列表导出入口与错误提示</li>
                <li>子任务：验证筛选条件与下载内容</li>
              </ul>
              <p className="mt-3 border-t border-border pt-3 font-medium">
                普通同步 → 一张父任务卡 → 同一 Worktree 内完成这些子任务
              </p>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              已有 Jira 子任务会成为父卡的交付范围，不重复建卡或再次拆分。 未拆分的 Epic / Story
              会等待 Jira 拆分或人工明确批准 Automaker 拆分，不会自动派发。 需要 Agent
              协助时，先审阅拆分建议、明确批准范围，再继续。
            </p>
          </section>
        </div>

        <section id="lanes" aria-labelledby="lanes-title" className="scroll-mt-6">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground">
            03 / WORKFLOW
          </p>
          <h2 id="lanes-title" className="mt-2 text-2xl font-semibold">
            任务如何在泳道间推进
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            正常路径：Backlog → In Progress → Waiting Review → Done。Needs Attention
            收集需要处理的异常； 项目配置的流水线还可能包含额外步骤。
          </p>
          <ol className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="任务泳道">
            {lanes.map((lane) => (
              <li
                key={lane.title}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className={`h-1.5 ${lane.color}`} />
                <div className="p-4">
                  <h3 className="font-semibold">{lane.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{lane.label}</p>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">{lane.description}</p>
                  <p className="mt-4 text-xs font-medium leading-5">{lane.action}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-4 rounded-xl border border-border bg-muted/40 p-5 text-sm leading-6">
            <p className="font-semibold">Done ≠ 已合并，Complete ≠ 归档</p>
            <p className="mt-2 text-muted-foreground">
              验收未通过，用 Reply 或 Request Changes 反馈；通过后 Verify。 Complete
              在人工确认后推进 MR 合并、Jira 关闭和预览资源释放，并保留分步结果。
              失败时先修复再重试，改了代码需重新验收。不再推进的任务单独归档，记录原因并保留交付材料。
            </p>
          </div>
        </section>

        <section id="interact" aria-labelledby="interact-title" className="scroll-mt-6">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground">
            04 / COLLABORATE
          </p>
          <h2 id="interact-title" className="mt-2 text-2xl font-semibold">
            监控任务，与 Agent 一起推进
          </h2>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <article className="rounded-xl border border-border bg-card p-6">
              <Activity className="mb-4 h-6 w-6 text-primary" aria-hidden="true" />
              <h3 className="text-lg font-semibold">看什么，去哪里看</h3>
              <dl className="mt-4 space-y-4 text-sm leading-6">
                <div>
                  <dt className="font-medium">Task Kanban · 单任务进度</dt>
                  <dd className="text-muted-foreground">
                    查看状态、执行日志、错误、需求更新、交付详情和验收材料。
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Work Board · 代码空间与交付</dt>
                  <dd className="text-muted-foreground">
                    按 Worktree 查看分支、差异、关联 PR / MR 和预览环境。
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">运行中的 Agent · 跨项目执行</dt>
                  <dd className="text-muted-foreground">
                    查看正在运行的任务与模型、打开日志，必要时停止任务。
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Jira Sync · 同步记录</dt>
                  <dd className="text-muted-foreground">
                    任务没导入或没启动时，检查查询结果、容量、依赖和拆分阻塞。
                  </dd>
                </div>
              </dl>
              {currentProject && (
                <Link
                  to="/worktrees"
                  className={buttonVariants({ variant: 'link', className: 'mt-4 px-0' })}
                >
                  打开 Work Board <ArrowRight aria-hidden="true" />
                </Link>
              )}
            </article>
            <article className="rounded-xl border border-border bg-card p-6">
              <MessageSquare className="mb-4 h-6 w-6 text-primary" aria-hidden="true" />
              <h3 className="text-lg font-semibold">什么时候，怎样回复</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
                <li>从任务卡打开 Conversation 查看会话；Agent 页面可查看 Herdr 工作区。</li>
                <li>
                  用 Reply
                  回答问题、明确范围或继续开发。说明期望行为和验收条件，避免只回复「继续」。
                </li>
                <li>出现「需求已更新」时，先比较新要求，再明确哪些内容纳入本次交付。</li>
                <li>
                  执行失败先看日志，再补充修复指令。会话断开可重新打开；先确认 Agent
                  是否仍在运行，避免重复启动。
                </li>
              </ol>
              <blockquote className="mt-5 border-l-2 border-primary pl-4 text-sm leading-6">
                「保留现有导出字段，仅补充无权限提示。请验证无权限账号无法下载，并提供测试结果和实际页面截图。」
              </blockquote>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Pi 任务会话需要服务端已配置 Pi、Herdr 和可用模型。
              </p>
              {currentProject && (
                <Link
                  to="/agent"
                  className={buttonVariants({ variant: 'link', className: 'mt-3 px-0' })}
                >
                  打开 Agent 工作区 <ArrowRight aria-hidden="true" />
                </Link>
              )}
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}
