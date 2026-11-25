import { Link } from '@tanstack/react-router';
import { ArrowRight, FolderOpen, GitBranch, LayoutGrid, PauseCircle, Archive } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';

const steps = [
  {
    title: 'Project',
    icon: FolderOpen,
    description: 'Open a repository or create a project. You land on its Work Board.',
    detail: 'Switch projects from the sidebar. Each project has its own work and settings.',
  },
  {
    title: 'Work Board',
    icon: GitBranch,
    description: 'See only the selected project’s work, grouped by progress.',
    detail: 'Choose New Work to create a branch and Worktree, or open an existing Work.',
  },
  {
    title: 'Task Kanban',
    icon: LayoutGrid,
    description: 'Opening a Work takes you to the tasks in that Worktree.',
    detail: 'Add tasks, define acceptance criteria, run agents and review delivery here.',
  },
];

const lanes = [
  {
    title: 'Backlog',
    color: 'bg-[var(--status-backlog)]',
    description: 'Confirm scope, dependencies and the agent model before starting.',
  },
  {
    title: 'In Progress',
    color: 'bg-[var(--status-in-progress)]',
    description: 'Follow execution and answer questions in the existing conversation.',
  },
  {
    title: 'Needs Attention',
    color: 'bg-[var(--status-error)]',
    description: 'Resolve blockers, missing decisions, failures or conflicts before continuing.',
  },
  {
    title: 'Waiting Review',
    color: 'bg-[var(--status-waiting)]',
    description: 'Review delivered changes, Draft PRs / MRs, tests and preview evidence.',
  },
  {
    title: 'Done',
    color: 'bg-[var(--status-success)]',
    description: 'Verified in Automaker. Review and confirm Complete to finish delivery.',
  },
];

export function GuideView() {
  const currentProject = useAppStore((state) => state.currentProject);

  return (
    <div className="flex-1 overflow-y-auto content-bg" data-testid="guide-view" lang="en">
      <div className="mx-auto max-w-6xl space-y-8 px-5 py-8 sm:px-10">
        <header className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-xl">
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-primary">
                Automaker / Workspace guide
              </p>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Guide</h1>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Start with a project. Organize work in isolated Worktrees, then take each task from
                requirements to reviewed delivery.
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-4 sm:min-w-64">
              <p className="text-xs text-muted-foreground">Current project</p>
              <p className="mt-1 break-words font-semibold">
                {currentProject?.name ?? 'No project selected'}
              </p>
              <p className="mt-2 max-w-sm break-all text-xs text-muted-foreground">
                {currentProject?.path ?? 'Open a project to see its work.'}
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3 [&>a]:h-auto [&>a]:min-h-9 [&>a]:whitespace-normal">
            <Link to={currentProject ? '/worktrees' : '/dashboard'} className={buttonVariants()}>
              {currentProject ? 'Open Work Board' : 'Open or create a project'}
              <ArrowRight aria-hidden="true" />
            </Link>
            <Link to="/" className={buttonVariants({ variant: 'outline' })}>
              Back to Home
            </Link>
            {currentProject && (
              <>
                <Link to="/dashboard" className={buttonVariants({ variant: 'outline' })}>
                  Switch project
                </Link>
                <Link to="/agent" className={buttonVariants({ variant: 'outline' })}>
                  Open Agent workspace
                </Link>
              </>
            )}
          </div>
        </header>

        <section aria-labelledby="work-flow-title">
          <h2 id="work-flow-title" className="text-xl font-semibold">
            Find your work
          </h2>
          <ol className="mt-4 grid gap-4 md:grid-cols-3" aria-label="Workspace flow">
            {steps.map(({ title, icon: Icon, description, detail }, index) => (
              <li key={title} className="rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                  <span className="text-xs font-medium text-muted-foreground">0{index + 1}</span>
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6">{description}</p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{detail}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="progress-title">
          <h2 id="progress-title" className="text-xl font-semibold">
            Know what needs you
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Work Board summarizes each Worktree. Task Kanban shows the individual tasks inside it.
            Needs Attention is an exception path; a blocked result still needs action.
          </p>
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Task lanes">
            {lanes.map((lane) => (
              <li
                key={lane.title}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className={`h-1 ${lane.color}`} />
                <div className="p-4">
                  <h3 className="text-sm font-semibold">{lane.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{lane.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section
            className="rounded-xl border border-border bg-card p-5"
            aria-labelledby="review-title"
          >
            <h2 id="review-title" className="text-lg font-semibold">
              Review and continue
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Open Conversation and use Reply to clarify requirements or request changes. Reuse the
              existing task session when continuing work.
            </p>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Inspect the diff, tests and actual preview screenshots before accepting. Draft PRs /
              MRs should be available before Waiting Review. Done records verification; merging and
              Jira closure require your confirmation in Complete.
            </p>
          </section>
          <section
            className="rounded-xl border border-border bg-card p-5"
            aria-labelledby="organize-title"
          >
            <h2 id="organize-title" className="text-lg font-semibold">
              Keep your Work Board focused
            </h2>
            <dl className="mt-3 space-y-4 text-sm leading-6">
              <div>
                <dt className="flex items-center gap-2 font-medium">
                  <PauseCircle className="h-4 w-4" aria-hidden="true" /> Snoozed Works
                </dt>
                <dd className="mt-1 text-muted-foreground">
                  Stop active tasks, then snooze work for later. Code and conversations stay intact.
                  Resume Worktree makes it available again without starting an agent.
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-2 font-medium">
                  <Archive className="h-4 w-4" aria-hidden="true" /> Archived Works
                </dt>
                <dd className="mt-1 text-muted-foreground">
                  Eligible work moves here after all its tasks have been Done for seven days. Search
                  its history here; new or reopened tasks bring it back to the board.
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <section
          className="rounded-xl border border-border bg-card p-5"
          aria-labelledby="jira-title"
        >
          <h2 id="jira-title" className="text-lg font-semibold">
            Bring in Jira requirements
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            In Project Settings → Jira Sync, configure the site, query and agent. Test the
            connection, preview the import, then sync. Review imported work before enabling
            automatic execution. Normal sync preserves execution and review decisions; it does not
            merge code or close Jira.
          </p>
          <details className="mt-4 text-sm leading-6">
            <summary className="cursor-pointer font-medium focus-visible:outline-primary">
              How task scope is preserved
            </summary>
            <p className="mt-2 text-muted-foreground">
              A parent issue and its existing Jira subtasks form one delivery card. An unsplit Epic
              or Story waits for decomposition or an explicit decision. Requirements updates do not
              automatically restart previous work.
            </p>
          </details>
          <Link
            to={currentProject ? '/project-settings' : '/dashboard'}
            search={currentProject ? { section: 'jira' } : {}}
            className={buttonVariants({ variant: 'link', className: 'mt-3 px-0' })}
          >
            {currentProject ? 'Configure Jira sync' : 'Select a project first'}
            <ArrowRight aria-hidden="true" />
          </Link>
        </section>
      </div>
    </div>
  );
}
