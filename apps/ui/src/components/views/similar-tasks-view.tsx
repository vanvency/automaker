import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RefreshCw, CopyCheck } from 'lucide-react';
import type { ConsolidationPlan, SimilarTask, SimilarTaskPair } from '@automaker/types';
import { useAppStore } from '@/store/app-store';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TaskDescriptionComparison } from './task-description-comparison';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Discovery {
  pairs: SimilarTaskPair[];
  tasks: SimilarTask[];
  history: ConsolidationPlan[];
}
async function call<T>(action: string, projectPath: string, body = {}): Promise<T> {
  const response = await apiFetch(`/api/task-consolidation/${action}`, 'POST', {
    body: { projectPath, ...body },
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'Task consolidation failed');
  return result.result;
}

export function SimilarTasksView() {
  const project = useAppStore((s) => s.currentProject);
  if (!project) return <div className="p-6">Select a project first.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-3 text-sm">
        <Link to="/worktrees" className="text-brand-500 hover:underline">
          ← Work Board
        </Link>
        <span className="text-muted-foreground">{project.name}</span>
      </div>
      <ProjectSimilarTasks key={project.path} projectPath={project.path} />
    </div>
  );
}

export function ProjectSimilarTasks({ projectPath }: { projectPath: string }) {
  const client = useQueryClient();
  const queryKey = ['similar-tasks', projectPath];
  const query = useQuery({
    queryKey,
    queryFn: () => call<Discovery>('list', projectPath),
    staleTime: 30000,
  });
  const [search, setSearch] = useState('');
  const [keepId, setKeepId] = useState('');
  const [retireId, setRetireId] = useState('');
  const [reason, setReason] = useState('');
  const [plan, setPlan] = useState<ConsolidationPlan | null>(null);
  const [mrUrls, setMrUrls] = useState<string[]>([]);
  const [closeJira, setCloseJira] = useState(false);
  const [transitionId, setTransitionId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [comparison, setComparison] = useState<[string, string] | null>(null);
  const openPlan = (value: ConsolidationPlan) => {
    setPlan(value);
    setConfirmation('');
    setMrUrls(value.selection?.mrUrls ?? []);
    setCloseJira(value.selection?.closeJira ?? false);
    setTransitionId(value.selection?.transitionId ?? '');
  };
  const preview = useMutation({
    mutationFn: () => call<ConsolidationPlan>('plan', projectPath, { keepId, retireId, reason }),
    onSuccess: (value) => {
      openPlan(value);
      void client.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error.message),
  });
  const apply = useMutation({
    mutationFn: () =>
      call<ConsolidationPlan>('apply', projectPath, {
        planId: plan!.id,
        confirmation,
        selection: plan!.selection ?? {
          mrUrls,
          closeJira,
          transitionId: closeJira ? transitionId : undefined,
        },
      }),
    onSuccess: (value) => {
      openPlan(value);
      void client.invalidateQueries({ queryKey });
      toast[value.status === 'complete' ? 'success' : 'error'](
        value.status === 'complete'
          ? 'Tasks consolidated. History has been preserved.'
          : 'Some steps could not be completed. Review the results before continuing.'
      );
    },
    onError: (error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey });
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      call<ConsolidationPlan>('cancel', projectPath, { planId: plan!.id, confirmation }),
    onSuccess: (value) => {
      openPlan(value);
      void client.invalidateQueries({ queryKey });
      toast.success('Cleanup cancelled. Completed external actions have been preserved.');
    },
    onError: (error) => toast.error(error.message),
  });
  const tasks = query.data?.tasks ?? [];
  const keep = tasks.find((task) => task.id === keepId),
    retire = tasks.find((task) => task.id === retireId);
  const candidates = (query.data?.pairs ?? []).filter((pair) =>
    `${pair.left.title} ${pair.right.title} ${pair.left.jiraKey} ${pair.right.jiraKey}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
  const selectPair = (pair: SimilarTaskPair, direction: 'left' | 'right') => {
    setKeepId(pair[direction].id);
    setRetireId(pair[direction === 'left' ? 'right' : 'left'].id);
    setReason('');
  };
  const safeUrl = (url: string) => (/^https?:\/\//.test(url) ? url : undefined);
  return (
    <div className="flex-1 overflow-auto p-6 space-y-5" data-testid="similar-tasks-view">
      <div className="flex justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Similar Works</h1>
          <p className="text-sm text-muted-foreground">
            Compare independent parent tasks only. Subtasks, parent–child pairs, and sibling
            subtasks are excluded. Discover overlap in titles and requirements. Confirm coverage
            before cleanup; similarity does not prove implementation coverage.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          <Button
            variant="outline"
            disabled={tasks.length < 2}
            onClick={() => setComparison(['', ''])}
          >
            Compare Any Two Tasks
          </Button>
          <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>
            <RefreshCw className="mr-1 h-4 w-4" />
            Refresh Candidates
          </Button>
        </div>
      </div>
      {query.error && (
        <p role="alert" className="text-destructive">
          {query.error.message}
        </p>
      )}
      {query.isPending && <p>Analyzing task requirements…</p>}
      <Input
        aria-label="Search similar tasks"
        placeholder="Search Jira key or task title…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="grid gap-3 xl:grid-cols-2">
        {candidates.map((pair) => (
          <section
            key={`${pair.left.id}:${pair.right.id}`}
            className="space-y-2 rounded-lg border p-3"
          >
            <div className="text-xs text-muted-foreground">
              Text similarity {pair.score}% · Coverage requires review
            </div>
            <p className="font-medium">{pair.left.title}</p>
            <p className="font-medium">{pair.right.title}</p>
            <p className="text-xs text-muted-foreground">{pair.reasons.join('; ')}</p>
            <p className="text-xs">Shared terms: {pair.sharedTerms.join(', ')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setComparison([pair.left.id, pair.right.id])}>
                Compare Descriptions
              </Button>
              <Button size="sm" variant="outline" onClick={() => selectPair(pair, 'left')}>
                Keep {pair.left.jiraKey || pair.left.id}
              </Button>
              <Button size="sm" variant="outline" onClick={() => selectPair(pair, 'right')}>
                Keep {pair.right.jiraKey || pair.right.id}
              </Button>
            </div>
          </section>
        ))}
      </div>
      {!query.isPending && !candidates.length && (
        <p className="text-muted-foreground">
          No matching candidates. You can also select two parent tasks below.
        </p>
      )}
      <section className="space-y-3 rounded-lg border p-4" data-testid="coverage-selection">
        <h2 className="font-semibold">Choose Which Parent Task to Keep</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            Task to keep
            <select
              aria-label="Task to keep"
              className="block w-full rounded border bg-background p-2"
              value={keepId}
              onChange={(e) => setKeepId(e.target.value)}
            >
              <option value="">Select a task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Covered task (card will be archived)
            <select
              aria-label="Covered task"
              className="block w-full rounded border bg-background p-2"
              value={retireId}
              onChange={(e) => setRetireId(e.target.value)}
            >
              <option value="">Select a task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {keep && retire && (
          <div className="grid gap-3 md:grid-cols-2">
            {[keep, retire].map((task) => (
              <details className="rounded border p-2" key={task.id}>
                <summary className="cursor-pointer text-sm">
                  {task.title} · {task.status}
                </summary>
                <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {task.scope || 'No requirements were extracted. Review the original task.'}
                </p>
                {task.summary && (
                  <>
                    <h4 className="mt-2 text-xs font-semibold">
                      Latest Delivery Notes (Review Required)
                    </h4>
                    <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {task.summary}
                    </p>
                  </>
                )}
              </details>
            ))}
          </div>
        )}
        <label className="block space-y-1 text-sm">
          Coverage rationale and reviewed acceptance criteria
          <textarea
            aria-label="Coverage rationale"
            className="block w-full rounded border bg-background p-2"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain how the retained task covers these requirements and whether any independent scope remains…"
          />
        </label>
        <Button
          disabled={
            !keepId ||
            !retireId ||
            keepId === retireId ||
            reason.trim().length < 5 ||
            preview.isPending
          }
          onClick={() => preview.mutate()}
        >
          <CopyCheck className="mr-1 h-4 w-4" />
          {preview.isPending ? 'Checking MR / Jira status…' : 'Preview Cleanup'}
        </Button>
        <p className="text-xs text-muted-foreground">
          This step is read-only. Select and confirm external actions in the preview.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Consolidation History</h2>
        {query.data?.history.map((item) => (
          <button
            key={item.id}
            className="block w-full rounded border p-3 text-left text-sm"
            onClick={() => openPlan(item)}
          >
            {item.retire.jiraKey || item.retire.title} → {item.keep.jiraKey || item.keep.title} ·{' '}
            {item.status} · {new Date(item.createdAt).toLocaleString()}
          </button>
        ))}
      </section>
      <TaskDescriptionComparison
        tasks={tasks}
        selection={comparison}
        onChange={setComparison}
        onClose={() => setComparison(null)}
        onKeep={(keep, retire) => {
          setKeepId(keep);
          setRetireId(retire);
          setReason('');
          setComparison(null);
        }}
      />
      <Dialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open && !apply.isPending && !cancel.isPending) setPlan(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Closure and Cleanup Preview</DialogTitle>
            <DialogDescription>
              Select external actions explicitly. Closing preserves history and does not revert
              merged code.
            </DialogDescription>
          </DialogHeader>
          {plan && (
            <>
              <p className="text-sm">
                Keep: {plan.keep.title}
                <br />
                Archive: {plan.retire.title}
              </p>
              <p className="whitespace-pre-wrap text-sm">{plan.reason}</p>
              {plan.warnings.map((warning, i) => (
                <p className="text-xs text-muted-foreground" key={i}>
                  {warning}
                </p>
              ))}
              {plan.blockers.map((blocker, i) => (
                <p className="text-sm text-destructive" key={i}>
                  {blocker}
                </p>
              ))}
              <fieldset
                disabled={apply.isPending || !!plan.selection || plan.status === 'complete'}
                className="space-y-3"
              >
                <h3 className="font-medium">Merge Requests</h3>
                {!plan.mergeRequests.length && (
                  <p className="text-sm text-muted-foreground">
                    No merge requests are recorded for this task.
                  </p>
                )}
                {plan.mergeRequests.map((mr) => (
                  <label className="flex items-start gap-2 rounded border p-2 text-xs" key={mr.url}>
                    <input
                      type="checkbox"
                      disabled={mr.action !== 'close'}
                      checked={mrUrls.includes(mr.url)}
                      onChange={(e) =>
                        setMrUrls((urls) =>
                          e.target.checked
                            ? [...urls, mr.url]
                            : urls.filter((url) => url !== mr.url)
                        )
                      }
                    />
                    <span className="break-all">
                      <a
                        href={safeUrl(mr.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-500 underline"
                      >
                        {mr.url}
                      </a>
                      <br />
                      {mr.state} ·{' '}
                      {mr.action === 'close' ? 'Eligible to close; select to confirm' : 'Preserve'}{' '}
                      · {mr.reason}
                    </span>
                  </label>
                ))}
                <h3 className="font-medium">Jira</h3>
                {plan.jira ? (
                  <>
                    <p className="text-sm">
                      {plan.jira.key} · {plan.jira.status}
                    </p>
                    {plan.jira.error && (
                      <p className="text-sm text-destructive">{plan.jira.error}</p>
                    )}
                    {plan.jira.done ? (
                      <p className="text-sm">
                        This Jira issue is already closed. No transition is needed.
                      </p>
                    ) : (
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={closeJira}
                          disabled={!!plan.jira.error || !plan.jira.transitions.length}
                          onChange={(e) => setCloseJira(e.target.checked)}
                        />
                        Close this Jira issue
                      </label>
                    )}
                    {!plan.jira.done && !plan.jira.error && !plan.jira.transitions.length && (
                      <p className="text-xs">
                        No terminal transition is available without additional input. Complete the
                        required fields in Jira.
                      </p>
                    )}
                    {closeJira && !plan.jira.done && (
                      <select
                        aria-label="Jira closing transition"
                        className="w-full rounded border bg-background p-2"
                        value={transitionId}
                        onChange={(e) => setTransitionId(e.target.value)}
                      >
                        <option value="">Select an available terminal transition</option>
                        {plan.jira.transitions.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} → {t.target}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                ) : (
                  <p className="text-sm">No linked Jira issue.</p>
                )}
              </fieldset>
              {plan.steps.map((step) => (
                <p className="break-all text-xs" key={step.target}>
                  {step.status} · {step.target}
                  {step.message ? ` · ${step.message}` : ''}
                </p>
              ))}
              {plan.status !== 'complete' && plan.status !== 'cancelled' && (
                <>
                  <label className="block text-sm">
                    Type the covered task key to confirm: {plan.retire.jiraKey || plan.retire.id}
                    <Input
                      aria-label="Confirm covered task key"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                    />
                  </label>
                  <Button
                    variant="destructive"
                    disabled={
                      apply.isPending ||
                      cancel.isPending ||
                      !!plan.blockers.length ||
                      confirmation !== (plan.retire.jiraKey || plan.retire.id) ||
                      (closeJira && !plan.jira?.done && !transitionId)
                    }
                    onClick={() => apply.mutate()}
                  >
                    {apply.isPending
                      ? 'Applying cleanup…'
                      : plan.selection
                        ? 'Verify and Resume Remaining Steps'
                        : 'Confirm Archive and Selected Cleanup'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      apply.isPending ||
                      cancel.isPending ||
                      confirmation !== (plan.retire.jiraKey || plan.retire.id)
                    }
                    onClick={() => cancel.mutate()}
                  >
                    Cancel Remaining Cleanup (Keep Completed Actions)
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Unselected MRs and Jira issues are preserved. Partial results are saved so you
                    can resume unfinished steps.
                  </p>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
