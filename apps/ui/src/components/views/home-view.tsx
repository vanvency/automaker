import { Link } from '@tanstack/react-router';
import { Activity, ArrowRight, BookOpen, ClipboardCheck, Clock, Wrench } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { useFeatures, useRunningAgents, useWorktreeProgress } from '@/hooks/queries';
import { summarizeProjectRoutines } from '@/lib/project-routines';
import { Button } from '@/components/ui/button';

const routines = [
  {
    category: 'Repo health',
    title: 'Weekday repo audit',
    description: 'Check dependencies, failing tests, and risky open changes each weekday.',
    cadence: 'Weekdays',
    icon: Activity,
  },
  {
    category: 'Release prep',
    title: 'Release readiness',
    description: 'Prepare a weekly release risk summary from the current project state.',
    cadence: 'Weekly',
    icon: ClipboardCheck,
  },
  {
    category: 'Recurring review',
    title: 'Daily change review',
    description: 'Scan recent work and call out correctness, UX, and test coverage risks.',
    cadence: 'Daily',
    icon: BookOpen,
  },
  {
    category: 'Maintenance',
    title: 'Hourly queue check',
    description: 'Look for stuck work, stale generated files, and failed local validation.',
    cadence: 'Hourly',
    icon: Wrench,
  },
];

export function HomeView() {
  const currentProject = useAppStore((state) => state.currentProject);

  return (
    <div className="flex-1 overflow-y-auto content-bg" data-testid="home-view" lang="en">
      <div className="mx-auto max-w-6xl space-y-8 px-5 py-8 sm:px-10">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-primary">
              Automaker
            </p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Home</h1>
            <p className="mt-3 break-words text-sm text-muted-foreground">
              {currentProject ? `Current project: ${currentProject.name}` : 'No project selected'}
            </p>
          </div>
          <Link to="/guide" className={buttonVariants({ variant: 'outline' })}>
            <BookOpen aria-hidden="true" />
            Guide
          </Link>
        </header>

        {currentProject ? (
          <ProjectRoutines key={currentProject.path} project={currentProject} />
        ) : (
          <section aria-labelledby="routines-title">
            <div className="mb-5">
              <h2 id="routines-title" className="text-xl font-semibold">
                Project routines
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Select a project to load its repository, tasks and recorded validation.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {routines.map(({ category, title, description, cadence, icon: Icon }) => (
                <article
                  key={title}
                  className="min-w-0 rounded-xl border border-border bg-card p-6"
                >
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {cadence}
                    </span>
                  </div>
                  <p className="text-xs font-medium text-primary">{category}</p>
                  <h3 className="mt-2 text-xl font-semibold">{title}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
                  <p className="mt-4 text-sm text-muted-foreground">No project selected</p>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-3 [&>a]:h-auto [&>a]:min-h-9 [&>a]:whitespace-normal">
          <Link to={currentProject ? '/worktrees' : '/dashboard'} className={buttonVariants()}>
            {currentProject ? 'Open Work Board' : 'Open or create a project'}
            <ArrowRight aria-hidden="true" />
          </Link>
          {currentProject && (
            <Link to="/dashboard" className={buttonVariants({ variant: 'outline' })}>
              Switch project
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRoutines({ project }: { project: { path: string; name: string } }) {
  const features = useFeatures(project.path);
  const progress = useWorktreeProgress([project]);
  const agents = useRunningAgents();
  const queries = [features, progress, agents];
  const errors = queries.flatMap((query, index) =>
    query.error ? [`${['Tasks', 'Worktrees', 'Agents'][index]}: ${query.error.message}`] : []
  );
  const refreshing = queries.some((query) => query.isFetching);
  const loaded = queries.every((query) => query.isFetchedAfterMount && query.data !== undefined);
  const summaries =
    loaded && errors.length === 0
      ? summarizeProjectRoutines(
          features.data!,
          progress.data!.rows.filter((row) => row.projectPath === project.path),
          new Set(
            agents
              .data!.agents.filter((agent) => agent.projectPath === project.path)
              .map((agent) => agent.featureId)
          ),
          Date.now()
        )
      : null;
  const oldestUpdate = Math.min(...queries.map((query) => query.dataUpdatedAt));
  const gitTimestamp = progress.data?.projects.find(
    (item) => item.projectPath === project.path
  )?.generatedAt;

  return (
    <section aria-labelledby="routines-title" aria-busy={refreshing}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="routines-title" className="text-xl font-semibold">
            Project routines
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Live project snapshot · updates while this page is open. No scheduled background audits.
          </p>
          {summaries && (
            <p className="mt-2 text-xs text-muted-foreground">
              Sources: task records, Git worktrees and tracked agents · refreshed{' '}
              <time dateTime={new Date(oldestUpdate).toISOString()}>
                {new Date(oldestUpdate).toLocaleString()}
              </time>
              {gitTimestamp && <> · Git collected {new Date(gitTimestamp).toLocaleString()}</>}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => {
            void features.refetch();
            void progress.refetch();
            void agents.refetch();
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </Button>
      </div>
      {errors.length > 0 && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          Could not refresh project data. {errors.join(' · ')} Use Refresh data to retry.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {routines.map(({ category, title, icon: Icon }, index) => {
          const summary = summaries?.[index];
          return (
            <article key={title} className="min-w-0 rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-3">
                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <p className="text-xs font-medium text-primary">{category}</p>
              </div>
              <h3 className="text-xl font-semibold">{title}</h3>
              {!summary ? (
                <p role="status" className="mt-4 text-sm text-muted-foreground">
                  {errors.length ? 'Data unavailable' : 'Loading project data…'}
                </p>
              ) : (
                <>
                  <dl className="mt-5 space-y-3 text-sm">
                    {summary.metrics.map(([label, value]) => (
                      <div key={label} className="flex items-start justify-between gap-4">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-semibold tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
                    {summary.note}
                  </p>
                  {summary.findings.length ? (
                    <details className="mt-4">
                      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-primary">
                        Inspect findings ({summary.findings.length})
                      </summary>
                      <ul className="mt-3 max-h-64 space-y-3 overflow-y-auto text-sm">
                        {summary.findings.map((item, findingIndex) => (
                          <li key={`${item.featureId ?? item.branch}-${findingIndex}`}>
                            <Link
                              to="/board"
                              search={{
                                projectPath: project.path,
                                featureId: item.featureId,
                                worktree: item.branch === '(detached)' ? undefined : item.branch,
                              }}
                              className="break-words font-medium text-primary hover:underline"
                            >
                              {item.title}
                            </Link>
                            <p className="break-words text-xs leading-5 text-muted-foreground">
                              {item.reason}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p className="mt-4 text-sm text-muted-foreground">
                      No findings in the available records.
                    </p>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
