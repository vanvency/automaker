/**
 * WorktreesView - Progress of every git worktree across the configured projects.
 *
 * Each row is one worktree: the feature it belongs to, its lifecycle stage, how
 * far the branch has moved relative to the base branch, uncommitted/conflicting
 * files and the linked pull request. Data comes from a single aggregated
 * endpoint (`POST /api/worktree/progress`) so the whole view is one request per
 * project.
 */

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock,
  Copy,
  CopyCheck,
  MoreHorizontal,
  GitBranch,
  GitCommit,
  GitPullRequest,
  FileText,
  LayoutGrid,
  Loader2,
  Plus,
  Play,
  RefreshCw,
  Rows3,
  Bot,
  XCircle,
  Archive,
  createLucideIcon,
  PlayCircle,
} from 'lucide-react';
import type {
  Feature,
  WorktreeProgressAttention,
  WorktreeProgressStage,
  WorktreeProgressTask,
} from '@automaker/types';
import { useAppStore } from '@/store/app-store';
import { getElectronAPI, isElectron } from '@/lib/electron';
import { apiFetch, withPageAuthParams } from '@/lib/api-fetch';
import { useRunningAgents, useWorktreeProgress, type WorktreeProgressRow } from '@/hooks/queries';
import { cn, formatRelativeTime } from '@/lib/utils';
import { writeToClipboard } from '@/lib/clipboard-utils';
import { queryKeys } from '@/lib/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { BoardSearchBar } from './board-view/board-search-bar';
import { ArchiveTaskDialog } from './board-view/dialogs/archive-task-dialog';
import { AgentOutputModal } from './board-view/dialogs/agent-output-modal';
import { ResetWorkAction } from './board-view/dialogs/reset-work-action';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorktreePreviewControls } from './worktree-preview';
import { CreateWorktreeDialog } from './board-view/dialogs/create-worktree-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const SnoozeIcon = createLucideIcon('Snooze', [
  ['circle', { cx: '12', cy: '13', r: '8', key: 'clock' }],
  ['path', { d: 'M9 10h6l-6 6h6', key: 'sleep' }],
  ['path', { d: 'M5 3 2 6m20 0-3-3M6.4 19 4 22m13.6-3L20 22', key: 'alarm' }],
]);

type BoardLane = 'planned' | 'in_progress' | 'failed' | 'waiting' | 'done';
type StageFilter = 'all' | BoardLane;
type SortKey = 'activity' | 'branch' | 'stage' | 'ahead' | 'changes' | 'project';

const STAGE_ORDER: WorktreeProgressStage[] = [
  'in_progress',
  'waiting_approval',
  'failed',
  'complete',
  'backlog',
  'empty',
  'unknown',
];

const STAGE_LABELS: Record<WorktreeProgressStage, string> = {
  in_progress: 'In Progress',
  waiting_approval: 'Waiting Review',
  failed: 'Needs Attention',
  complete: 'Done',
  backlog: 'Backlog',
  empty: 'No feature',
  unknown: 'Unknown',
};

const STAGE_BADGE: Record<
  WorktreeProgressStage,
  'brand' | 'success' | 'warning' | 'error' | 'muted' | 'outline'
> = {
  in_progress: 'brand',
  waiting_approval: 'warning',
  failed: 'error',
  complete: 'success',
  backlog: 'muted',
  empty: 'outline',
  unknown: 'outline',
};

/** Position of a stage on the Planned → Building → Review → Done track. */
const STAGE_STEP: Record<WorktreeProgressStage, number> = {
  empty: 0,
  backlog: 0,
  unknown: 0,
  in_progress: 1,
  failed: 1,
  waiting_approval: 2,
  complete: 3,
};

const STAGE_TRACK_LABELS = ['Planned', 'Building', 'Review', 'Done'];

/** Short label + dot colour per card stage, for the subtask list. */
const TASK_STAGE_META: Record<
  WorktreeProgressStage,
  { label: string; dotClass: string; textClass?: string }
> = {
  in_progress: { label: 'In Progress', dotClass: 'bg-brand-500' },
  waiting_approval: { label: 'Waiting Review', dotClass: 'bg-[var(--status-warning)]' },
  failed: {
    label: 'Needs Attention',
    dotClass: 'bg-[var(--status-error)]',
    textClass: 'text-[var(--status-error)]',
  },
  complete: { label: 'Done', dotClass: 'bg-[var(--status-success)]' },
  backlog: { label: 'Backlog', dotClass: 'bg-muted-foreground/40' },
  empty: { label: 'No Tasks', dotClass: 'bg-muted-foreground/30' },
  unknown: { label: 'Unknown', dotClass: 'bg-muted-foreground/30' },
};

const SORTABLE_COLUMNS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: 'project', label: 'Project', className: 'hidden xl:table-cell' },
  { key: 'branch', label: 'Worktree' },
  { key: 'stage', label: 'Stage' },
  { key: 'activity', label: 'Last activity' },
  { key: 'ahead', label: 'Position' },
  { key: 'changes', label: 'Working tree' },
];

function stageIcon(stage: WorktreeProgressStage, running: boolean) {
  if (running) return Loader2;
  switch (stage) {
    case 'in_progress':
      return Play;
    case 'waiting_approval':
      return Clock;
    case 'complete':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'empty':
      return CircleDot;
    default:
      return CircleDot;
  }
}

/** Compact 4-step track showing how far the worktree got. */
function StageTrack({ stage, running }: { stage: WorktreeProgressStage; running: boolean }) {
  const step = STAGE_STEP[stage];
  const isFailed = stage === 'failed';

  return (
    <div className="flex items-center gap-1" title={STAGE_TRACK_LABELS[step]}>
      {STAGE_TRACK_LABELS.map((label, index) => (
        <span
          key={label}
          className={cn(
            'h-1.5 w-5 rounded-full transition-colors',
            index <= step
              ? isFailed && index === step
                ? 'bg-[var(--status-error)]'
                : running && index === step
                  ? 'bg-brand-500 animate-pulse'
                  : 'bg-brand-500'
              : 'bg-muted'
          )}
        />
      ))}
    </div>
  );
}

function PositionCell({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5',
          ahead > 0 ? 'bg-brand-500/10 text-brand-500' : 'text-muted-foreground'
        )}
        title={`${ahead} commit(s) ahead of the base branch`}
      >
        ↑{ahead}
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5',
          behind > 0
            ? 'bg-[var(--status-warning-bg)] text-[var(--status-warning)]'
            : 'text-muted-foreground'
        )}
        title={`${behind} commit(s) behind the base branch`}
      >
        ↓{behind}
      </span>
    </div>
  );
}

/**
 * Level-1 board columns.
 *
 * A worktree is the unit of parallel work ("大任务"), so the columns follow the
 * workflow the work actually moves through: queue → active → review → blocked →
 * archive. The set of stages comes from the progress endpoint
 * (`WorktreeProgressStage`); `failed` carries everything that needs a human
 * (execution failure, merge conflict, interrupted run), which is why that lane
 * is labelled "Needs Attention".
 */
const BOARD_COLUMNS: Array<{
  id: BoardLane;
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
  colorClass: string;
  tone?: 'brand' | 'warning' | 'error' | 'success';
}> = [
  {
    id: 'planned',
    label: 'Backlog',
    hint: 'Queued but not started',
    icon: CircleDot,
    colorClass: 'text-[var(--status-backlog)]',
  },
  {
    id: 'in_progress',
    label: 'In Progress',
    hint: 'An agent is working in this worktree',
    icon: Play,
    colorClass: 'text-[var(--status-in-progress)]',
  },
  {
    id: 'failed',
    label: 'Needs Attention',
    hint: 'Execution failed, merge conflict or interrupted run - a human has to act',
    icon: AlertTriangle,
    colorClass: 'text-[var(--status-error)]',
    tone: 'error',
  },
  {
    id: 'waiting',
    label: 'Waiting Review',
    hint: 'The agent has stopped and is waiting for review',
    icon: Clock,
    colorClass: 'text-[var(--status-waiting)]',
    tone: 'warning',
  },
  {
    id: 'done',
    label: 'Done',
    hint: 'Verified or merged',
    icon: CheckCircle2,
    colorClass: 'text-[var(--status-success)]',
    tone: 'success',
  },
];

/** Attention reasons that move a worktree into the Needs Attention lane. */
const ATTENTION_IN_NEEDS_ATTENTION = new Set<WorktreeProgressAttention>([
  'conflicts',
  'needs_input',
  'failed',
]);

/** Shared by counters, filters, board lanes and the table. */
export function getWorktreeLane(row: WorktreeProgressRow, running: boolean): BoardLane {
  if (running) return 'in_progress';
  if (
    row.stage === 'failed' ||
    row.hasConflicts ||
    (row.attention && ATTENTION_IN_NEEDS_ATTENTION.has(row.attention))
  )
    return 'failed';
  if (row.stage === 'in_progress') return 'in_progress';
  if (row.stage === 'waiting_approval') return 'waiting';
  if (row.stage === 'complete') return 'done';
  return 'planned';
}

function isWorktreeRunning(row: WorktreeProgressRow, ids: Set<string>): boolean {
  return (
    !!(row.feature && ids.has(row.feature.id)) || !!row.tasks?.some((task) => ids.has(task.id))
  );
}

/** Attention reasons that should stand out on the card. */
const ATTENTION_META: Partial<
  Record<WorktreeProgressAttention, { label: string; variant: 'error' | 'warning' }>
> = {
  conflicts: { label: 'Conflicts', variant: 'error' },
  needs_input: { label: 'Needs Input', variant: 'warning' },
  failed: { label: 'Execution Failed', variant: 'error' },
};

/**
 * The worktree's task rollup: how many cards (the task and its children) are
 * done, and what is still running / waiting / failing.
 */
function TaskRollup({ row }: { row: WorktreeProgressRow }) {
  const counts = row.counts;
  if (!counts || counts.total <= 1) return null;

  const percent = counts.total === 0 ? 0 : Math.round((counts.completed / counts.total) * 100);
  const parts = [
    counts.running > 0 ? `${counts.running} In Progress` : null,
    counts.waiting > 0 ? `${counts.waiting} Waiting Review` : null,
    counts.backlog > 0 ? `${counts.backlog} Backlog` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          Tasks {counts.completed}/{counts.total} done
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full',
            counts.failed > 0 ? 'bg-[var(--status-warning)]' : 'bg-[var(--status-success)]'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {(parts.length > 0 || counts.failed > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          {parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
          {counts.failed > 0 && (
            <span className="text-[var(--status-error)]">{counts.failed} Needs Attention</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The worktree's decomposed subtasks.
 *
 * A worktree delivers one big task, and that task is often planned as several
 * child cards (parents first, as returned by the progress endpoint). Listing them
 * here means the overview answers "what is this worktree still doing?" without
 * opening the board.
 */
export function selectCardSubtasks(tasks: WorktreeProgressTask[]): {
  /** The card the worktree's main agent conversation belongs to, if any */
  mainTask: WorktreeProgressTask | null;
  /** The decomposed subtasks to list on the card */
  children: WorktreeProgressTask[];
} {
  // The worktree's own task owns the children; the endpoint returns it first.
  const parent = tasks.find((task) => task.isParent) ?? null;
  const mainTask = parent ?? tasks[0] ?? null;
  const children = parent
    ? tasks.filter((task) => parent.childIds.includes(task.id))
    : // No parent on this branch: the worktree's cards are siblings, not
      // subtasks, so the card lists none and the rollup speaks for itself.
      [];
  return { mainTask, children };
}

function SubtaskList({
  tasks,
  onLocate,
}: {
  tasks: WorktreeProgressTask[];
  onLocate: (task: WorktreeProgressTask) => void;
}) {
  // Hooks must run before any early return, so keep this first.
  const [expanded, setExpanded] = useState(false);

  const { children } = selectCardSubtasks(tasks);
  const listed = expanded ? children : children.slice(0, 3);
  const hidden = children.length - listed.length;

  if (children.length === 0) return null;

  return (
    <div className="space-y-1" data-testid="card-subtasks">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Subtasks {children.length}</span>
        {hidden > 0 && (
          <button
            type="button"
            className="text-brand-500 hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            +{hidden} Show more
          </button>
        )}
        {expanded && children.length > 3 && (
          <button
            type="button"
            className="text-muted-foreground hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(false);
            }}
          >
            Show less
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {listed.map((task) => {
          const meta = TASK_STAGE_META[task.stage];
          return (
            <li key={task.id} className="flex min-w-0 items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dotClass)} />
              <span
                className="truncate text-[10px] text-muted-foreground"
                title={task.title || task.id}
              >
                {task.title || task.jiraKey || task.id}
              </span>
              <span
                className={cn(
                  'ml-auto shrink-0 text-[10px]',
                  meta.textClass ?? 'text-muted-foreground'
                )}
              >
                {meta.label}
              </span>
              <button
                type="button"
                className="shrink-0 text-[10px] text-brand-500 hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  onLocate(task);
                }}
                title="Locate this task on the Task Kanban"
              >
                Locate
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One level-1 card: the worktree's task, its progress and the signals a human
 * needs to decide what to pick up next. Clicking it opens the level-2 board for
 * that work line.
 */
function WorktreeTaskCard({
  row,
  running,
  isCurrentProject,
  herdrBusy,
  onOpenBoard,
  onCopyJiraId,
  onOpenLink,
  onLocateTask,
  onOpenHerdr,
  onViewLogs,
  onSnooze,
  onArchive,
  archiveBusy,
  onReset,
}: {
  row: WorktreeProgressRow;
  running: boolean;
  isCurrentProject: boolean;
  herdrBusy: boolean;
  onOpenBoard: (row: WorktreeProgressRow) => void;
  onCopyJiraId: (row: WorktreeProgressRow) => void;
  onOpenLink: (url: string) => void;
  onLocateTask: (row: WorktreeProgressRow, task: WorktreeProgressTask) => void;
  onOpenHerdr: (row: WorktreeProgressRow) => void;
  onViewLogs: (row: WorktreeProgressRow, featureId: string) => void;
  onSnooze: (row: WorktreeProgressRow) => void;
  onArchive: (row: WorktreeProgressRow) => void;
  archiveBusy: boolean;
  onReset: () => void | Promise<void>;
}) {
  const attention = row.attention ? ATTENTION_META[row.attention] : undefined;
  const title = row.feature?.title || row.branch;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const tasks = row.tasks ?? [];
  // The task that owns this worktree (the parent card when the work was split).
  // Its agent conversation is the one the Herdr button opens.
  const { mainTask } = selectCardSubtasks(tasks);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenBoard(row)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpenBoard(row);
        }
      }}
      className="group cursor-pointer space-y-3 rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-colors hover:border-brand-500/40 hover:bg-accent/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
      data-testid={`task-card-${row.branch}`}
      title={row.path}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[10px] text-muted-foreground">{row.projectName}</span>
        {row.isMain && (
          <Badge variant="outline" size="sm">
            main
          </Badge>
        )}
        {attention && (
          <Badge variant={attention.variant} size="sm" className="ml-auto shrink-0">
            {attention.label}
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5" data-testid="work-card-actions">
          {row.feature?.jiraKey && !row.isMain && !row.archivedAt && (
            <ResetWorkAction
              projectPath={row.projectPath}
              featureId={row.feature.id}
              icon
              disabled={
                running || archiveBusy || tasks.length !== 1 || tasks[0]?.id !== row.feature.id
              }
              onReset={onReset}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            onClick={(event) => {
              stop(event);
              onSnooze(row);
            }}
            title="Snooze Work"
            aria-label="Snooze Work"
            disabled={running || row.isMain || row.branch === '(detached)'}
            onKeyDown={(event) => event.stopPropagation()}
            data-testid={`snooze-worktree-${row.branch}`}
          >
            <SnoozeIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            aria-label="Archive Work"
            title="Archive Work"
            disabled={archiveBusy || running || row.isMain || !row.tasks?.length}
            onClick={(event) => {
              stop(event);
              onArchive(row);
            }}
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="line-clamp-2 text-sm font-medium leading-snug" title={row.feature?.title}>
        {title}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <GitBranch className="h-3 w-3 shrink-0" />
        <span className="truncate font-mono" title={row.branch}>
          {row.branch}
        </span>
      </div>

      {row.feature?.jiraKey && (
        <div className="flex items-center gap-1.5 text-xs" data-testid="work-jira-row">
          <span className="text-muted-foreground">Jira</span>
          <button
            type="button"
            className="shrink-0 rounded bg-muted px-1 text-[10px] hover:bg-accent hover:text-foreground"
            title={
              row.feature.jiraUrl ? `Open ${row.feature.jiraKey} in Jira` : row.feature.jiraKey
            }
            disabled={!row.feature.jiraUrl}
            onClick={(event) => {
              stop(event);
              if (row.feature?.jiraUrl) onOpenLink(row.feature.jiraUrl);
            }}
          >
            {row.feature.jiraKey}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(event) => {
              stop(event);
              onCopyJiraId(row);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={!row.feature?.jiraKey}
            title={row.feature?.jiraKey ? `Copy ${row.feature.jiraKey}` : 'No Jira ID linked'}
            aria-label="Copy Jira ID"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <dl className="grid gap-1 text-xs text-muted-foreground">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Reporter</dt>
          <dd className="truncate" title={row.feature?.jiraReporter || undefined}>
            {row.feature?.jiraReporterDisplayName || row.feature?.jiraReporter || 'Not available'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Assignee</dt>
          <dd className="truncate" title={row.feature?.jiraAssignee || undefined}>
            {row.feature?.jiraAssigneeDisplayName || row.feature?.jiraAssignee || 'Unassigned'}
          </dd>
        </div>
      </dl>

      <TaskRollup row={row} />

      <WorktreePreviewControls projectPath={row.projectPath} worktreePath={row.path} />

      <SubtaskList tasks={tasks} onLocate={(task) => onLocateTask(row, task)} />

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        {running && (
          <span className="inline-flex items-center gap-1 text-brand-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running
          </span>
        )}
        {row.hasConflicts ? (
          <span className="inline-flex items-center gap-1 text-[var(--status-error)]">
            <AlertTriangle className="h-3 w-3" />
            {row.conflictType ?? 'conflict'}
          </span>
        ) : row.hasChanges ? (
          <span className="inline-flex items-center gap-1 text-[var(--status-warning)]">
            <GitCommit className="h-3 w-3" />
            {row.changedFilesCount} files
          </span>
        ) : (
          <span>clean</span>
        )}
        <span title={`${row.ahead} ahead / ${row.behind} behind`}>
          ↑{row.ahead} ↓{row.behind}
        </span>
        {row.lastActivityAt && (
          <span className="ml-auto">{formatRelativeTime(new Date(row.lastActivityAt))}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-border/40 pt-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={(event) => {
            stop(event);
            onOpenBoard(row);
          }}
          title={
            isCurrentProject
              ? 'Open this worktree on the Task Kanban'
              : `Open the ${row.projectName} board`
          }
        >
          <LayoutGrid className="mr-1 h-3 w-3" />
          Kanban
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          disabled={herdrBusy || !mainTask}
          onClick={(event) => {
            stop(event);
            onOpenHerdr(row);
          }}
          title={
            mainTask
              ? `Open the main agent conversation for ${mainTask.title || mainTask.id}`
              : 'No task is linked to this worktree'
          }
          data-testid={`open-herdr-${row.branch}`}
        >
          {herdrBusy ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Bot className="mr-1 h-3 w-3" />
          )}
          Agent
        </Button>
        {getWorktreeLane(row, running) === 'failed' && (mainTask || row.feature) && (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={(event) => {
              stop(event);
              onViewLogs(row, mainTask?.id ?? row.feature!.id);
            }}
            title="Logs"
            aria-label="Logs"
          >
            <FileText className="mr-1 h-3 w-3" />
            Logs
          </Button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {row.pr && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(event) => {
                stop(event);
                onOpenLink(row.pr!.url);
              }}
              aria-label="Open pull request"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  selected,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: 'brand' | 'warning' | 'error' | 'success';
  selected: boolean;
  onClick: () => void;
}) {
  const toneClass = {
    brand: 'text-brand-500 bg-brand-500/10',
    warning: 'text-[var(--status-warning)] bg-[var(--status-warning-bg)]',
    error: 'text-[var(--status-error)] bg-[var(--status-error-bg)]',
    success: 'text-[var(--status-success)] bg-[var(--status-success-bg)]',
  }[tone ?? 'brand'];

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected ? 'border-brand-500/50 bg-brand-500/10' : 'border-border/50 bg-card/50'
      )}
    >
      <div
        className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', toneClass)}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-none">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </button>
  );
}

export function WorktreesView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projects, currentProject, setCurrentProject } = useAppStore();

  const [search, setSearch] = useState('');
  const [reporterFilter, setReporterFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{
    projectPath: string;
    ids: string[];
    features: Pick<Feature, 'id' | 'title' | 'jiraKey'>[];
    loading: boolean;
  } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  useEffect(() => {
    setReporterFilter('');
    setAssigneeFilter('');
    setArchiveSelection(null);
  }, [currentProject?.path]);
  const [createWorkOpen, setCreateWorkOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeRow, setSnoozeRow] = useState<WorktreeProgressRow | null>(null);
  const [snoozeReason, setSnoozeReason] = useState('');
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeSearch, setSnoozeSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [onlyWithChanges, setOnlyWithChanges] = useState(false);
  const [hideMain, setHideMain] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('activity');
  const [sortDesc, setSortDesc] = useState(true);
  // Level-1 default: a board of tasks by stage. The table stays one click away
  // for the dense, sortable view.
  const [viewMode, setViewMode] = useState<'board' | 'table'>('board');
  /** Worktrees whose Herdr attach is being resolved (per project+path) */
  const [herdrBusy, setHerdrBusy] = useState<Set<string>>(new Set());
  const [logTarget, setLogTarget] = useState<{
    projectPath: string;
    featureId: string;
    branchName: string;
  } | null>(null);

  const activeProjects = useMemo(() => (currentProject ? [currentProject] : []), [currentProject]);

  const { data, isLoading, isFetching, refetch, error } = useWorktreeProgress(
    activeProjects,
    activeProjects.length > 0
  );
  const { data: runningAgentsData } = useRunningAgents();

  const runningFeatureIds = useMemo(
    () => new Set((runningAgentsData?.agents ?? []).map((agent) => agent.featureId)),
    [runningAgentsData]
  );

  const rows = useMemo(
    () => (data?.rows ?? []).filter((row) => row.projectPath === currentProject?.path),
    [data, currentProject?.path]
  );
  const peopleOptions = useMemo(() => {
    const options = (role: 'Reporter' | 'Assignee') =>
      [
        ...new Map(
          rows.flatMap(({ feature }) => {
            const id = feature?.[`jira${role}`] || feature?.[`jira${role}DisplayName`];
            return id ? [[id, feature?.[`jira${role}DisplayName`] || id] as [string, string]] : [];
          })
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1]));
    return { reporter: options('Reporter'), assignee: options('Assignee') };
  }, [rows]);
  const archivedRows = useMemo(
    () =>
      rows
        .filter(
          (row) => row.archivedAt && !row.snoozedAt && !isWorktreeRunning(row, runningFeatureIds)
        )
        .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!)),
    [rows, runningFeatureIds]
  );
  const archivedKeys = useMemo(
    () => new Set(archivedRows.map((row) => `${row.projectPath}:${row.branch}`)),
    [archivedRows]
  );
  const snoozedRows = useMemo(
    () =>
      rows
        .filter((row) => row.snoozedAt && !isWorktreeRunning(row, runningFeatureIds))
        .sort((a, b) => Date.parse(b.snoozedAt!) - Date.parse(a.snoozedAt!)),
    [rows, runningFeatureIds]
  );
  const snoozedKeys = useMemo(
    () => new Set(snoozedRows.map((row) => `${row.projectPath}:${row.branch}`)),
    [snoozedRows]
  );
  const visibleSnoozed = snoozedRows.filter((row) =>
    [
      row.projectName,
      row.branch,
      row.snoozeReason,
      ...(row.tasks ?? []).map((task) => `${task.title} ${task.jiraKey} ${task.id}`),
    ]
      .join(' ')
      .toLowerCase()
      .includes(snoozeSearch.trim().toLowerCase())
  );
  const visibleArchives = archivedRows.filter((row) =>
    [
      row.projectName,
      row.branch,
      ...(row.tasks ?? []).map((task) => `${task.title} ${task.jiraKey} ${task.id}`),
    ]
      .join(' ')
      .toLowerCase()
      .includes(archiveSearch.trim().toLowerCase())
  );

  const scopedRows = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = rows.filter((row) => {
      if (archivedKeys.has(`${row.projectPath}:${row.branch}`)) return false;
      if (snoozedKeys.has(`${row.projectPath}:${row.branch}`)) return false;
      if (hideMain && row.isMain) return false;
      if (onlyWithChanges && !row.hasChanges && !row.hasConflicts) return false;
      const reporter =
        row.feature?.jiraReporter || row.feature?.jiraReporterDisplayName || '__missing__';
      const assignee =
        row.feature?.jiraAssignee || row.feature?.jiraAssigneeDisplayName || '__missing__';
      if (reporterFilter && reporter !== reporterFilter) return false;
      if (assigneeFilter && assignee !== assigneeFilter) return false;

      if (!query) return true;
      const haystack = [
        row.branch,
        row.path,
        row.projectName,
        row.feature?.id,
        row.feature?.title,
        row.feature?.jiraKey,
        row.feature?.jiraReporter,
        row.feature?.jiraReporterDisplayName,
        row.feature?.jiraAssignee,
        row.feature?.jiraAssigneeDisplayName,
        row.head?.subject,
        row.head?.sha,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    return filtered;
  }, [
    rows,
    search,
    hideMain,
    onlyWithChanges,
    archivedKeys,
    snoozedKeys,
    reporterFilter,
    assigneeFilter,
  ]);

  const laneRows = useMemo(
    () =>
      scopedRows.map((row) => {
        const running = isWorktreeRunning(row, runningFeatureIds);
        return { row, running, lane: getWorktreeLane(row, running) };
      }),
    [scopedRows, runningFeatureIds]
  );

  const stats = useMemo(() => {
    const counts = {
      total: laneRows.length,
      planned: 0,
      in_progress: 0,
      failed: 0,
      waiting: 0,
      done: 0,
    };
    for (const { lane } of laneRows) counts[lane] += 1;
    return counts;
  }, [laneRows]);

  const visibleRows = useMemo(() => {
    const filtered = laneRows
      .filter(({ lane }) => stageFilter === 'all' || lane === stageFilter)
      .map(({ row }) => row);
    const direction = sortDesc ? -1 : 1;
    const sorted = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'branch':
          return a.branch.localeCompare(b.branch) * direction;
        case 'project':
          return (
            (a.projectName.localeCompare(b.projectName) || a.branch.localeCompare(b.branch)) *
            direction
          );
        case 'stage': {
          const delta = (STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)) * direction;
          return delta !== 0 ? delta : a.branch.localeCompare(b.branch);
        }
        case 'ahead':
          return (a.ahead - b.ahead) * direction || a.branch.localeCompare(b.branch);
        case 'changes':
          return (
            (a.changedFilesCount - b.changedFilesCount) * direction ||
            a.branch.localeCompare(b.branch)
          );
        case 'activity':
        default: {
          const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
          const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
          if (aTime !== bTime) return (aTime - bTime) * direction;
          return a.branch.localeCompare(b.branch);
        }
      }
    });

    return sorted;
  }, [laneRows, stageFilter, sortKey, sortDesc]);

  const baseBranches = useMemo(() => {
    const unique = new Set(
      (data?.projects ?? [])
        .map((project) => project.baseBranch)
        .filter((branch): branch is string => !!branch)
    );
    return [...unique];
  }, [data]);

  const lastUpdatedAt = useMemo(() => {
    const timestamps = (data?.projects ?? [])
      .map((project) => project.generatedAt)
      .filter((value): value is string => !!value)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));
    return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
  }, [data]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDesc((previous) => !previous);
      } else {
        setSortKey(key);
        // Activity and "ahead" are most useful newest/largest first.
        setSortDesc(key === 'activity' || key === 'ahead' || key === 'changes');
      }
    },
    [sortKey]
  );

  const openOnBoard = useCallback(
    (row: WorktreeProgressRow) => {
      const project = projects.find((candidate) => candidate.path === row.projectPath);
      if (project) setCurrentProject(project);
      // Carry the work line into the board so the URL restores this worktree.
      navigate({
        to: '/board',
        search: {
          projectPath: row.projectPath,
          ...(row.branch === '(detached)' ? {} : { worktree: row.branch }),
        },
      });
    },
    [projects, setCurrentProject, navigate]
  );

  const copyJiraId = useCallback(async (row: WorktreeProgressRow) => {
    const jiraKey = row.feature?.jiraKey;
    if (!jiraKey) return;
    if (await writeToClipboard(jiraKey)) {
      toast.success(`${jiraKey} copied`);
    } else {
      toast.error('Could not copy Jira ID');
    }
  }, []);

  const openArchive = async (row: WorktreeProgressRow) => {
    if (archiveBusy) return;
    const selection = {
      projectPath: row.projectPath,
      ids: (row.tasks ?? []).map((task) => task.id),
      features: row.tasks ?? [],
      loading: true,
    };
    setArchiveSelection(selection);
    setArchiveBusy(true);
    try {
      const result = await getElectronAPI().features?.getAll(row.projectPath);
      if (!result?.success || !result.features)
        throw new Error(result?.error || 'Could not load tasks');
      const ids = result.features
        .filter((feature) => feature.branchName === row.branch && !feature.archive)
        .map((feature) => feature.id);
      if (!ids.length) throw new Error('No active tasks to archive');
      setArchiveSelection((current) =>
        current === selection
          ? { projectPath: row.projectPath, ids, features: result.features!, loading: false }
          : current
      );
    } catch (error) {
      setArchiveSelection((current) => (current === selection ? null : current));
      toast.error(error instanceof Error ? error.message : 'Could not load tasks');
    } finally {
      setArchiveBusy(false);
    }
  };

  const updateSnooze = useCallback(
    async (row: WorktreeProgressRow, snoozed: boolean) => {
      setSnoozeBusy(true);
      try {
        const response = await apiFetch('/api/worktree/snooze', 'POST', {
          body: {
            projectPath: row.projectPath,
            branchName: row.branch,
            snoozed,
            reason: snoozed ? snoozeReason : undefined,
          },
        });
        const result = await response.json();
        if (!response.ok || !result.success)
          throw new Error(result.error || 'Could not update worktree');
        toast.success(snoozed ? 'Worktree snoozed' : 'Worktree resumed');
        if (snoozed) setSnoozeOpen(false);
        setSnoozeRow(null);
        setSnoozeReason('');
        await queryClient.invalidateQueries({ queryKey: queryKeys.features.all(row.projectPath) });
        await refetch();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not update worktree');
      } finally {
        setSnoozeBusy(false);
      }
    },
    [refetch, snoozeReason, queryClient]
  );

  // Open the level-2 board on a specific card: a worktree can hold several
  // cards, so the subtask list deep-links to the one that was clicked.
  const locateTask = useCallback(
    (row: WorktreeProgressRow, task: WorktreeProgressTask) => {
      const project = projects.find((candidate) => candidate.path === row.projectPath);
      if (project) setCurrentProject(project);
      navigate({
        to: '/board',
        search: {
          projectPath: row.projectPath,
          ...(row.branch === '(detached)' ? {} : { worktree: row.branch }),
          featureId: task.id,
        },
      });
    },
    [projects, setCurrentProject, navigate]
  );

  /**
   * Open the worktree task's agent conversation in the Herdr terminal.
   *
   * Herdr keeps one multiplexer session per worktree, so this attaches the
   * browser to the same TUI a terminal user would get - the place where the
   * main agent for this work was run.
   */
  const openHerdr = useCallback(async (row: WorktreeProgressRow) => {
    const { mainTask } = selectCardSubtasks(row.tasks ?? []);
    if (!mainTask) {
      toast.error('No task is linked to this worktree');
      return;
    }

    const key = `${row.projectPath}:${row.path}`;
    // Open the tab before awaiting so the browser keeps the user gesture.
    const pendingTab = isElectron() ? null : window.open('', '_blank');
    setHerdrBusy((previous) => new Set(previous).add(key));
    try {
      const api = getElectronAPI();
      const getHerdrWeb = api.features?.getHerdrWeb;
      if (!getHerdrWeb) throw new Error('Herdr is not supported by this client');

      const result = await getHerdrWeb(row.projectPath, mainTask.id);
      if (!result?.success || !result.url) {
        throw new Error(result?.error || 'Could not open the herdr terminal');
      }

      // The page and its xterm assets are served by the server, so the tab
      // needs its own credentials.
      const url = withPageAuthParams(new URL(result.url, window.location.origin));
      if (pendingTab) {
        pendingTab.location.replace(url.toString());
      } else {
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      pendingTab?.close();
      toast.error(error instanceof Error ? error.message : 'Open herdr terminal failed');
    } finally {
      setHerdrBusy((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const openLink = useCallback((url: string) => {
    try {
      getElectronAPI().openExternalLink(url);
    } catch {
      window.open(url, '_blank');
    }
  }, []);

  if (!currentProject) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        <Button onClick={() => void navigate({ to: '/dashboard' })}>
          Open or create a project
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size="xl" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-3 lg:p-4">
      <CreateWorktreeDialog
        key={currentProject.path}
        open={createWorkOpen}
        onOpenChange={setCreateWorkOpen}
        projectPath={currentProject.path}
        onCreated={(worktree) => {
          const store = useAppStore.getState();
          store.setWorktrees(currentProject.path, [
            ...store
              .getWorktrees(currentProject.path)
              .filter((tree) => tree.path !== worktree.path),
            { ...worktree, isMain: false, isCurrent: false, hasWorktree: true },
          ]);
          store.setCurrentWorktree(currentProject.path, worktree.path, worktree.branch);
          void queryClient.invalidateQueries({
            queryKey: queryKeys.worktrees.all(currentProject.path),
          });
          void navigate({
            to: '/board',
            search: { projectPath: currentProject.path, worktree: worktree.branch },
          });
        }}
      />
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="rounded-md bg-brand-500/10 p-1.5">
            <GitBranch className="h-4 w-4 text-brand-500" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-5">Work Board</h1>
            <p className="text-[11px] text-muted-foreground">
              {stats.total} worktree{stats.total === 1 ? '' : 's'}
              {currentProject ? ` · ${currentProject.name}` : ''}
              {activeProjects.length > 1 ? ` across ${activeProjects.length} projects` : ''}
              {baseBranches.length > 0 ? ` · compared against ${baseBranches.join(', ')}` : ''}
            </p>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="default"
            size="sm"
            onClick={() => setCreateWorkOpen(true)}
            disabled={!currentProject}
            data-testid="new-work-button"
          >
            <Plus className="h-4 w-4" />
            New Work
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More work actions"
                title="More work actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setArchiveOpen(true)}
                data-testid="archived-works-button"
              >
                <Archive className="h-4 w-4" /> Archived Works ({archivedRows.length})
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setSnoozeRow(null);
                  setSnoozeSearch('');
                  setSnoozeOpen(true);
                }}
                data-testid="snoozed-works-button"
              >
                <SnoozeIcon className="h-4 w-4" /> Snoozed Works ({snoozedRows.length})
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void navigate({ to: '/similar-tasks' });
                }}
                data-testid="work-board-similar-tasks"
              >
                <CopyCheck className="h-4 w-4" /> Similar Works
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center rounded-md border border-border/60 p-0.5">
            <Button
              variant={viewMode === 'board' ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={() => setViewMode('board')}
              aria-label="Board view"
              aria-pressed={viewMode === 'board'}
              title="Board view by stage"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={() => setViewMode('table')}
              aria-label="Table view"
              aria-pressed={viewMode === 'table'}
              title="Sortable table view"
            >
              <Rows3 className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-xs text-muted-foreground"
            aria-label="Refresh work board"
            title={
              lastUpdatedAt
                ? `Refresh · updated ${formatRelativeTime(lastUpdatedAt)}`
                : 'Refresh work board'
            }
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {isFetching
                ? 'Refreshing…'
                : lastUpdatedAt
                  ? `Updated ${formatRelativeTime(lastUpdatedAt)}`
                  : 'Refresh'}
            </span>
          </Button>
        </div>
      </div>

      <Dialog
        open={snoozeOpen}
        onOpenChange={(open) => {
          if (!snoozeBusy) setSnoozeOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{snoozeRow ? 'Snooze Worktree' : 'Snoozed Works'}</DialogTitle>
            <DialogDescription>
              Snoozed work is hidden from active lanes and excluded from automatic dispatch.
              Existing code and task history are preserved.
              {' Showing the selected project.'}
            </DialogDescription>
          </DialogHeader>
          {snoozeRow ? (
            <>
              <p className="text-sm font-medium">{snoozeRow.feature?.title || snoozeRow.branch}</p>
              <p className="text-xs text-muted-foreground">{snoozeRow.branch}</p>
              <Input
                aria-label="Snooze reason"
                placeholder="Optional reason"
                maxLength={500}
                value={snoozeReason}
                onChange={(event) => setSnoozeReason(event.target.value)}
                disabled={snoozeBusy}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSnoozeOpen(false)}
                  disabled={snoozeBusy}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void updateSnooze(snoozeRow, true)}
                  disabled={snoozeBusy}
                  data-testid="confirm-snooze"
                >
                  <SnoozeIcon className="mr-1 h-4 w-4" />
                  Snooze Worktree
                </Button>
              </div>
            </>
          ) : (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              <Input
                aria-label="Search snoozed works"
                placeholder="Search project, branch or task..."
                value={snoozeSearch}
                onChange={(event) => setSnoozeSearch(event.target.value)}
              />
              {snoozedRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No snoozed works.</p>
              ) : (
                visibleSnoozed.map((row) => (
                  <article
                    key={`${row.projectPath}:${row.branch}`}
                    className="rounded-lg border p-3"
                  >
                    <p className="font-medium">{row.feature?.title || row.branch}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.projectName} · {row.branch}
                    </p>
                    {row.snoozeReason && (
                      <p className="mt-2 text-sm text-muted-foreground">{row.snoozeReason}</p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      Snoozed: {new Date(row.snoozedAt!).toLocaleString()}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSnoozeOpen(false);
                        openOnBoard(row);
                      }}
                    >
                      Open tasks
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => void updateSnooze(row, false)}
                      disabled={snoozeBusy}
                    >
                      <PlayCircle className="mr-1 h-4 w-4" />
                      Resume Worktree
                    </Button>
                  </article>
                ))
              )}
              {snoozedRows.length > 0 && visibleSnoozed.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No matching snoozed works.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {archiveSelection && (
        <ArchiveTaskDialog
          projectPath={archiveSelection.projectPath}
          featureIds={archiveSelection.ids}
          features={archiveSelection.features}
          loading={archiveSelection.loading}
          workScope
          onClose={() => setArchiveSelection(null)}
          onArchived={() => {
            void refetch();
          }}
        />
      )}
      {logTarget && (
        <AgentOutputModal
          open
          onClose={() => setLogTarget(null)}
          projectPath={logTarget.projectPath}
          featureId={logTarget.featureId}
          branchName={logTarget.branchName}
        />
      )}
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent
          className="max-w-4xl max-h-[85vh] flex flex-col"
          data-testid="archived-works-dialog"
        >
          <DialogHeader>
            <DialogTitle>Archived Works</DialogTitle>
            <DialogDescription>
              Archived works include manually archived tasks and works that have been Done for 7
              days. Code and task history are preserved. New or reopened tasks return the work to
              the board.
              {' Showing the selected project.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search archived works"
            placeholder="Search project, branch or task…"
            value={archiveSearch}
            onChange={(event) => setArchiveSearch(event.target.value)}
          />
          <div className="min-h-0 overflow-y-auto space-y-3">
            {archivedRows.length === 0 && (
              <p className="py-8 text-center text-muted-foreground">No archived works yet.</p>
            )}
            {archivedRows.length > 0 && visibleArchives.length === 0 && (
              <p className="py-8 text-center text-muted-foreground">No matching archived works.</p>
            )}
            {visibleArchives.map((row) => (
              <article
                key={`${row.projectPath}:${row.branch}`}
                className="rounded-lg border p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-medium break-words">{row.feature?.title || row.branch}</h3>
                  <Badge variant={row.manuallyArchived ? 'muted' : 'success'}>
                    {row.manuallyArchived ? 'Archived' : 'Done'}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground break-all">
                  {row.projectName} · {row.branch}
                </p>
                <p className="text-xs text-muted-foreground">
                  Completed: {row.doneAt ? new Date(row.doneAt).toLocaleString() : '—'} · Archived:{' '}
                  {new Date(row.archivedAt!).toLocaleString()}
                </p>
                {row.checkoutMissing && (
                  <p className="text-xs text-muted-foreground">
                    Local checkout released. Task records and conversation history are retained.
                  </p>
                )}
                <ul className="space-y-1 text-sm">
                  {(row.tasks ?? []).map((task) => (
                    <li key={task.id} className="break-words">
                      {task.title || task.jiraKey || task.id}{' '}
                      <span className="text-muted-foreground">
                        · {row.manuallyArchived ? 'Archived' : 'Done'}
                      </span>
                    </li>
                  ))}
                </ul>
                {!row.checkoutMissing && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setArchiveOpen(false);
                      openOnBoard(row);
                    }}
                  >
                    Open tasks
                  </Button>
                )}
              </article>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--status-error)]/30 bg-[var(--status-error-bg)] px-3 py-2 text-sm text-[var(--status-error)]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load worktree progress'}
        </div>
      )}

      {/* Status cards also filter the board/table using the same lane assignment. */}
      <div
        className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
        aria-label="Filter by status"
      >
        <StatCard
          icon={LayoutGrid}
          label="All"
          value={stats.total}
          selected={stageFilter === 'all'}
          onClick={() => setStageFilter('all')}
        />
        {BOARD_COLUMNS.map((column) => (
          <StatCard
            key={column.id}
            icon={column.icon}
            label={column.label}
            value={stats[column.id]}
            tone={column.tone}
            selected={stageFilter === column.id}
            onClick={() => setStageFilter(stageFilter === column.id ? 'all' : column.id)}
          />
        ))}
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BoardSearchBar
          searchQuery={search}
          onSearchChange={setSearch}
          isCreatingSpec={false}
          showConversations={false}
          placeholder="Search work, Jira ID or person..."
        />
        {(['reporter', 'assignee'] as const).map((role) => (
          <select
            key={role}
            aria-label={`Filter by ${role}`}
            value={role === 'reporter' ? reporterFilter : assigneeFilter}
            onChange={(event) =>
              (role === 'reporter' ? setReporterFilter : setAssigneeFilter)(event.target.value)
            }
            className="h-9 max-w-[220px] rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All {role === 'reporter' ? 'reporters' : 'assignees'}</option>
            <option value="__missing__">
              {role === 'reporter' ? 'Reporter not available' : 'Unassigned'}
            </option>
            {peopleOptions[role].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ))}
        {(reporterFilter || assigneeFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReporterFilter('');
              setAssigneeFilter('');
            }}
          >
            Clear filters
          </Button>
        )}

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyWithChanges}
            onChange={(event) => setOnlyWithChanges(event.target.checked)}
            className="accent-brand-500"
          />
          Uncommitted only
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hideMain}
            onChange={(event) => setHideMain(event.target.checked)}
            className="accent-brand-500"
          />
          Hide main worktree
        </label>
      </div>

      {/* Board: one card per worktree (the unit of parallel work), by stage */}
      {viewMode === 'board' && (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
          {BOARD_COLUMNS.filter((column) => stageFilter === 'all' || column.id === stageFilter).map(
            (column) => {
              const ColumnIcon = column.icon;
              const columnRows = visibleRows
                .map((row) => ({ row, running: isWorktreeRunning(row, runningFeatureIds) }))
                .filter(({ row, running }) => getWorktreeLane(row, running) === column.id);

              return (
                <section
                  key={column.id}
                  className="flex min-w-[200px] flex-1 basis-0 flex-col rounded-xl border border-border/60 bg-card/80"
                  aria-labelledby={`work-lane-${column.id}`}
                  data-testid={`task-column-${column.id}`}
                >
                  <header
                    className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5"
                    title={column.hint}
                  >
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-current/10',
                        column.colorClass
                      )}
                      aria-hidden="true"
                    >
                      <ColumnIcon className="h-4 w-4" />
                    </span>
                    <h2
                      id={`work-lane-${column.id}`}
                      className="min-w-0 flex-1 text-sm font-semibold tracking-tight text-foreground/90"
                    >
                      {column.label}
                    </h2>
                    <span
                      className="rounded-md bg-muted/50 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground/80"
                      aria-label={`${columnRows.length} works`}
                    >
                      {columnRows.length}
                    </span>
                  </header>
                  <div
                    className={cn(
                      'flex-1 overflow-y-auto p-2',
                      stageFilter === 'all'
                        ? 'space-y-2'
                        : 'grid content-start items-start gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]'
                    )}
                  >
                    {columnRows.map(({ row, running }) => (
                      <WorktreeTaskCard
                        key={`${row.projectPath}:${row.path}`}
                        row={row}
                        running={running}
                        isCurrentProject={currentProject?.path === row.projectPath}
                        herdrBusy={herdrBusy.has(`${row.projectPath}:${row.path}`)}
                        onOpenBoard={openOnBoard}
                        onCopyJiraId={copyJiraId}
                        onOpenLink={openLink}
                        onLocateTask={locateTask}
                        onOpenHerdr={openHerdr}
                        onViewLogs={(row, featureId) =>
                          setLogTarget({
                            projectPath: row.projectPath,
                            featureId,
                            branchName: row.branch,
                          })
                        }
                        onArchive={openArchive}
                        archiveBusy={archiveBusy}
                        onReset={() => void refetch()}
                        onSnooze={(row) => {
                          setSnoozeRow(row);
                          setSnoozeReason('');
                          setSnoozeOpen(true);
                        }}
                      />
                    ))}
                    {columnRows.length === 0 && (
                      <p className="py-6 text-center text-xs text-muted-foreground">—</p>
                    )}
                  </div>
                </section>
              );
            }
          )}
        </div>
      )}

      {/* Table */}
      {viewMode === 'table' && (
        <div className="flex-1 overflow-auto rounded-lg border border-border/50">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <tr className="border-b border-border/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                {SORTABLE_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className={cn(
                      'cursor-pointer px-3 py-2 font-medium select-none',
                      column.className
                    )}
                    onClick={() => handleSort(column.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {column.label}
                      {sortKey === column.key && <span>{sortDesc ? '↓' : '↑'}</span>}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Feature</th>
                <th className="px-3 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Preview</th>
                <th className="w-20 px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const running = isWorktreeRunning(row, runningFeatureIds);
                const lane = getWorktreeLane(row, running);
                const effectiveStage: WorktreeProgressStage =
                  lane === 'failed' ? 'failed' : running ? 'in_progress' : row.stage;
                const StageIcon = stageIcon(effectiveStage, false);
                const Icon = running ? Loader2 : StageIcon;
                // A live agent means work is happening right now, even when the
                // stored feature status still says it is waiting for review.
                const trackStage = effectiveStage;

                return (
                  <tr
                    key={`${row.projectPath}:${row.path}`}
                    className="border-b border-border/30 transition-colors hover:bg-accent/40"
                  >
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                      {row.projectName}
                    </td>

                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{row.branch}</span>
                        {row.isMain && (
                          <Badge variant="outline" size="sm">
                            main
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate" title={row.path}>
                          {row.path.replace(`${row.projectPath}/`, '') || '.'}
                        </span>
                        {row.head?.sha && <span className="font-mono">{row.head.sha}</span>}
                      </div>
                    </td>

                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant={STAGE_BADGE[effectiveStage]}
                          size="sm"
                          className="w-fit gap-1"
                        >
                          <Icon className={cn('h-3 w-3', running && 'animate-spin')} />
                          {STAGE_LABELS[effectiveStage]}
                        </Badge>
                        <StageTrack stage={trackStage} running={running} />
                      </div>
                    </td>

                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                      {row.lastActivityAt ? formatRelativeTime(new Date(row.lastActivityAt)) : '—'}
                    </td>

                    <td className="px-3 py-2">
                      <PositionCell ahead={row.ahead} behind={row.behind} />
                    </td>

                    <td className="px-3 py-2">
                      {row.hasConflicts ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="error" size="sm" className="gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              {row.conflictType ?? 'conflict'}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {(row.conflictFiles ?? []).join(', ') || 'Unresolved conflicts'}
                          </TooltipContent>
                        </Tooltip>
                      ) : row.hasChanges ? (
                        <span className="text-xs text-[var(--status-warning)]">
                          {row.changedFilesCount} file{row.changedFilesCount === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">clean</span>
                      )}
                    </td>

                    <td className="max-w-[320px] px-3 py-2">
                      {row.feature ? (
                        <div className="min-w-0">
                          <div className="truncate" title={row.feature.title ?? row.feature.id}>
                            {row.feature.title || row.feature.id}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate">
                              {row.feature.jiraKey ?? row.feature.id}
                            </span>
                            {row.feature.jiraKey && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Copy Jira ID"
                                title={`Copy ${row.feature.jiraKey}`}
                                onClick={() => copyJiraId(row)}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {row.featureCount > 1 && (
                              <span className="shrink-0">+{row.featureCount - 1} more</span>
                            )}
                            {row.feature.jiraUrl && (
                              <button
                                onClick={() => openLink(row.feature!.jiraUrl!)}
                                className="shrink-0 text-brand-500 hover:underline"
                              >
                                Jira
                              </button>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Reporter:{' '}
                            {row.feature.jiraReporterDisplayName ||
                              row.feature.jiraReporter ||
                              'Not available'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Assignee:{' '}
                            {row.feature.jiraAssigneeDisplayName ||
                              row.feature.jiraAssignee ||
                              'Unassigned'}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">No feature linked</span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      {row.pr ? (
                        <button
                          onClick={() => openLink(row.pr!.url)}
                          className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
                        >
                          <GitPullRequest className="h-3.5 w-3.5" />#{row.pr.number}
                          <span className="text-muted-foreground">
                            {row.pr.state.toLowerCase()}
                          </span>
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <WorktreePreviewControls
                        projectPath={row.projectPath}
                        worktreePath={row.path}
                      />
                    </td>

                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {row.feature?.jiraKey && !row.isMain && !row.archivedAt && (
                          <ResetWorkAction
                            projectPath={row.projectPath}
                            featureId={row.feature.id}
                            icon
                            disabled={
                              running ||
                              archiveBusy ||
                              row.tasks?.length !== 1 ||
                              row.tasks[0]?.id !== row.feature.id
                            }
                            onReset={() => void refetch()}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Archive Work"
                          title="Archive Work"
                          disabled={archiveBusy || running || row.isMain || !row.tasks?.length}
                          onClick={() => void openArchive(row)}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Snooze worktree"
                          disabled={running || row.isMain || row.branch === '(detached)'}
                          onClick={() => {
                            setSnoozeRow(row);
                            setSnoozeReason('');
                            setSnoozeOpen(true);
                          }}
                        >
                          <SnoozeIcon className="h-3.5 w-3.5" />
                        </Button>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openOnBoard(row)}
                              aria-label="Open on board"
                            >
                              <LayoutGrid className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {currentProject?.path === row.projectPath
                              ? 'Open board'
                              : `Open ${row.projectName} board`}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {visibleRows.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <GitBranch className="h-8 w-8 opacity-40" />
              <p className="text-sm">No worktrees match the current filters.</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing {visibleRows.length} of {stats.total} worktrees
        </span>
        {(data?.projects ?? []).some((project) => project.error) && (
          <span className="text-[var(--status-error)]">
            {data?.projects
              .filter((project) => project.error)
              .map((project) => `${project.projectName}: ${project.error}`)
              .join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}
