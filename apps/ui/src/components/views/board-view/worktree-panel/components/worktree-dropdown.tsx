import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  GitBranch,
  ChevronDown,
  CircleDot,
  Globe,
  GitPullRequest,
  FlaskConical,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  WorktreeInfo,
  BranchInfo,
  DevServerInfo,
  PRInfo,
  GitRepoStatus,
  TestSessionInfo,
  MergeConflictInfo,
  FeatureInfo,
} from '../types';
import { WorktreeDropdownItem } from './worktree-dropdown-item';
import { BranchSwitchDropdown } from './branch-switch-dropdown';
import { WorktreeActionsDropdown } from './worktree-actions-dropdown';
import { useRecentWorktreesStore } from '@/store/recent-worktrees-store';
import { buildWorktreeCategoryGroups, withRecentWorktrees } from './worktree-category-utils';
import {
  truncateBranchName,
  getPRBadgeStyles,
  getChangesBadgeStyles,
  getConflictBadgeStyles,
  getConflictTypeLabel,
  getTestStatusStyles,
} from './worktree-indicator-utils';

export interface WorktreeDropdownProps {
  /** List of all worktrees to display in the dropdown */
  worktrees: WorktreeInfo[];
  projectPath?: string;
  /** Function to check if a worktree is currently selected */
  isWorktreeSelected: (worktree: WorktreeInfo) => boolean;
  /** Function to check if a worktree has running features/processes */
  hasRunningFeatures: (worktree: WorktreeInfo) => boolean;
  /** Whether worktree activation is in progress */
  isActivating: boolean;
  /** Map of branch names to card counts */
  branchCardCounts?: Record<string, number>;
  /** Board cards, used to categorise and search the worktree list */
  features?: FeatureInfo[];
  /** Function to check if dev server is running for a worktree */
  isDevServerRunning: (worktree: WorktreeInfo) => boolean;
  /** Function to check if dev server is starting for a worktree */
  isDevServerStarting: (worktree: WorktreeInfo) => boolean;
  /** Function to get dev server info for a worktree */
  getDevServerInfo: (worktree: WorktreeInfo) => DevServerInfo | undefined;
  /** Function to check if auto-mode is running for a worktree */
  isAutoModeRunningForWorktree: (worktree: WorktreeInfo) => boolean;
  /** Function to check if tests are running for a worktree */
  isTestRunningForWorktree: (worktree: WorktreeInfo) => boolean;
  /** Function to get test session info for a worktree */
  getTestSessionInfo: (worktree: WorktreeInfo) => TestSessionInfo | undefined;
  /** Callback when a worktree is selected */
  onSelectWorktree: (worktree: WorktreeInfo) => void;

  // Branch switching props
  branches: BranchInfo[];
  filteredBranches: BranchInfo[];
  branchFilter: string;
  isLoadingBranches: boolean;
  isSwitching: boolean;
  onBranchDropdownOpenChange: (worktree: WorktreeInfo) => (open: boolean) => void;
  onBranchFilterChange: (value: string) => void;
  onSwitchBranch: (worktree: WorktreeInfo, branchName: string) => void;
  onCreateBranch: (worktree: WorktreeInfo) => void;

  // Action dropdown props
  isPulling: boolean;
  isPushing: boolean;
  isStartingAnyDevServer: boolean;
  aheadCount: number;
  behindCount: number;
  hasRemoteBranch: boolean;
  /** The name of the remote that the current branch is tracking (e.g. "origin"), if any */
  trackingRemote?: string;
  /** Per-worktree tracking remote lookup */
  getTrackingRemote?: (worktreePath: string) => string | undefined;
  gitRepoStatus: GitRepoStatus;
  hasTestCommand: boolean;
  isStartingTests: boolean;
  hasInitScript: boolean;
  onActionsDropdownOpenChange: (worktree: WorktreeInfo) => (open: boolean) => void;
  onPull: (worktree: WorktreeInfo) => void;
  onPush: (worktree: WorktreeInfo) => void;
  onPushNewBranch: (worktree: WorktreeInfo) => void;
  onOpenInEditor: (worktree: WorktreeInfo, editorCommand?: string) => void;
  onOpenInIntegratedTerminal: (worktree: WorktreeInfo, mode?: 'tab' | 'split') => void;
  onOpenInExternalTerminal: (worktree: WorktreeInfo, terminalId?: string) => void;
  onViewChanges: (worktree: WorktreeInfo) => void;
  onViewCommits: (worktree: WorktreeInfo) => void;
  onDiscardChanges: (worktree: WorktreeInfo) => void;
  onCommit: (worktree: WorktreeInfo) => void;
  onCreatePR: (worktree: WorktreeInfo) => void;
  onChangePRNumber?: (worktree: WorktreeInfo) => void;
  onAddressPRComments: (worktree: WorktreeInfo, prInfo: PRInfo) => void;
  onAutoAddressPRComments: (worktree: WorktreeInfo, prInfo: PRInfo) => void;
  onResolveConflicts: (worktree: WorktreeInfo) => void;
  onMerge: (worktree: WorktreeInfo) => void;
  onDeleteWorktree: (worktree: WorktreeInfo) => void;
  onStartDevServer: (worktree: WorktreeInfo) => void;
  onStopDevServer: (worktree: WorktreeInfo) => void;
  onOpenDevServerUrl: (worktree: WorktreeInfo) => void;
  onViewDevServerLogs: (worktree: WorktreeInfo) => void;
  onRunInitScript: (worktree: WorktreeInfo) => void;
  onToggleAutoMode: (worktree: WorktreeInfo) => void;
  onStartTests: (worktree: WorktreeInfo) => void;
  onStopTests: (worktree: WorktreeInfo) => void;
  onViewTestLogs: (worktree: WorktreeInfo) => void;
  /** Stash changes for this worktree */
  onStashChanges?: (worktree: WorktreeInfo) => void;
  /** View stashes for this worktree */
  onViewStashes?: (worktree: WorktreeInfo) => void;
  /** Cherry-pick commits from another branch */
  onCherryPick?: (worktree: WorktreeInfo) => void;
  /** Abort an in-progress merge/rebase/cherry-pick */
  onAbortOperation?: (worktree: WorktreeInfo) => void;
  /** Continue an in-progress merge/rebase/cherry-pick after resolving conflicts */
  onContinueOperation?: (worktree: WorktreeInfo) => void;
  /** Create a feature to resolve merge/rebase/cherry-pick conflicts with AI */
  onCreateConflictResolutionFeature?: (conflictInfo: MergeConflictInfo) => void;
  /** Remotes cache: maps worktree path to list of remotes */
  remotesCache?: Record<string, Array<{ name: string; url: string }>>;
  /** Pull from a specific remote, bypassing the remote selection dialog */
  onPullWithRemote?: (worktree: WorktreeInfo, remote: string) => void;
  /** Push to a specific remote, bypassing the remote selection dialog */
  onPushWithRemote?: (worktree: WorktreeInfo, remote: string) => void;
  /** Terminal quick scripts configured for the project */
  terminalScripts?: import('@/components/views/project-settings-view/terminal-scripts-constants').TerminalScript[];
  /** Callback to run a terminal quick script in a new terminal session */
  onRunTerminalScript?: (worktree: WorktreeInfo, command: string) => void;
  /** Callback to open the script editor UI */
  onEditScripts?: () => void;
  /** Whether sync is in progress */
  isSyncing?: boolean;
  /** Sync (pull + push) callback */
  onSync?: (worktree: WorktreeInfo) => void;
  /** Sync with a specific remote */
  onSyncWithRemote?: (worktree: WorktreeInfo, remote: string) => void;
  /** Set tracking branch to a specific remote */
  onSetTracking?: (worktree: WorktreeInfo, remote: string) => void;
  /** List of remote names that have a branch matching the current branch name */
  remotesWithBranch?: string[];
  /** When false, the trigger button uses a subdued style instead of the primary highlight. Defaults to true. */
  highlightTrigger?: boolean;
}

/**
 * Maximum characters for branch name before truncation in the dropdown trigger.
 * Set to 24 to keep the trigger compact while showing enough context for identification.
 */
const MAX_TRIGGER_BRANCH_NAME_LENGTH = 24;

/**
 * A dropdown component for displaying and switching between worktrees.
 * Used when there are 3+ worktrees to avoid horizontal tab wrapping.
 *
 * Features:
 * - Compact dropdown trigger showing current worktree with indicators
 * - Keyword search over branch, path, cards and pull requests
 * - Grouped display (工作中 / 空闲 / 新增 / 已完成)
 * - Full status indicators (PR, dev server, auto mode, changes)
 * - Branch switch dropdown integration
 * - Actions dropdown integration
 * - Tooltip for truncated branch names
 */
export function WorktreeDropdown({
  worktrees,
  projectPath,
  isWorktreeSelected,
  hasRunningFeatures,
  isActivating,
  branchCardCounts,
  features,
  isDevServerRunning,
  isDevServerStarting,
  getDevServerInfo,
  isAutoModeRunningForWorktree,
  isTestRunningForWorktree,
  getTestSessionInfo,
  onSelectWorktree,
  // Branch switching props
  branches,
  filteredBranches,
  branchFilter,
  isLoadingBranches,
  isSwitching,
  onBranchDropdownOpenChange,
  onBranchFilterChange,
  onSwitchBranch,
  onCreateBranch,
  // Action dropdown props
  isPulling,
  isPushing,
  isStartingAnyDevServer,
  aheadCount,
  behindCount,
  hasRemoteBranch,
  trackingRemote,
  getTrackingRemote,
  gitRepoStatus,
  hasTestCommand,
  isStartingTests,
  hasInitScript,
  onActionsDropdownOpenChange,
  onPull,
  onPush,
  onPushNewBranch,
  onOpenInEditor,
  onOpenInIntegratedTerminal,
  onOpenInExternalTerminal,
  onViewChanges,
  onViewCommits,
  onDiscardChanges,
  onCommit,
  onCreatePR,
  onChangePRNumber,
  onAddressPRComments,
  onAutoAddressPRComments,
  onResolveConflicts,
  onMerge,
  onDeleteWorktree,
  onStartDevServer,
  onStopDevServer,
  onOpenDevServerUrl,
  onViewDevServerLogs,
  onRunInitScript,
  onToggleAutoMode,
  onStartTests,
  onStopTests,
  onViewTestLogs,
  onStashChanges,
  onViewStashes,
  onCherryPick,
  onAbortOperation,
  onContinueOperation,
  onCreateConflictResolutionFeature,
  remotesCache,
  onPullWithRemote,
  onPushWithRemote,
  terminalScripts,
  onRunTerminalScript,
  onEditScripts,
  isSyncing = false,
  onSync,
  onSyncWithRemote,
  onSetTracking,
  remotesWithBranch,
  highlightTrigger = true,
}: WorktreeDropdownProps) {
  const recentPaths = useRecentWorktreesStore((state) =>
    projectPath ? state.pathsByProject[projectPath] : undefined
  );
  // Find the currently selected worktree to display in the trigger
  const selectedWorktree = worktrees.find((w) => isWorktreeSelected(w));
  const displayBranch =
    selectedWorktree?.branch ??
    (worktrees.length > 0 ? `+${worktrees.length} more` : 'Select worktree');
  const { truncated: truncatedBranch, isTruncated: isBranchNameTruncated } = truncateBranchName(
    displayBranch,
    MAX_TRIGGER_BRANCH_NAME_LENGTH
  );

  // Keyword filter for the worktree list
  const [searchQuery, setSearchQuery] = useState('');

  // Jira work type per branch, taken from the cards of that worktree, so legacy
  // `jira/<key>-<label>` branches still show whether they carry a story, task, ...
  const jiraTypeByBranch = useMemo(() => {
    const byBranch: Record<string, string> = {};
    for (const feature of features ?? []) {
      if (feature.branchName && feature.jiraType && !byBranch[feature.branchName]) {
        byBranch[feature.branchName] = feature.jiraType;
      }
    }
    return byBranch;
  }, [features]);

  // Worktrees grouped as 工作中 / 空闲 / 新增 / 已完成 (in that order) and narrowed
  // down by the keyword filter. Memoized to avoid regrouping on every render.
  const categoryGroups = useMemo(
    () =>
      withRecentWorktrees(
        buildWorktreeCategoryGroups(
          worktrees,
          {
            isRunning: (worktree) =>
              hasRunningFeatures(worktree) ||
              isAutoModeRunningForWorktree(worktree) ||
              isTestRunningForWorktree(worktree),
            features,
            cardCounts: branchCardCounts,
          },
          searchQuery
        ),
        recentPaths
      ),
    [
      worktrees,
      hasRunningFeatures,
      isAutoModeRunningForWorktree,
      isTestRunningForWorktree,
      features,
      branchCardCounts,
      searchQuery,
      recentPaths,
    ]
  );

  // Get status info for selected worktree - memoized to prevent unnecessary recalculations
  const selectedStatus = useMemo(() => {
    if (!selectedWorktree) {
      return {
        devServerRunning: false,
        devServerStarting: false,
        devServerInfo: undefined,
        autoModeRunning: false,
        isRunning: false,
        testRunning: false,
        testSessionInfo: undefined,
      };
    }
    return {
      devServerRunning: isDevServerRunning(selectedWorktree),
      devServerStarting: isDevServerStarting(selectedWorktree),
      devServerInfo: getDevServerInfo(selectedWorktree),
      autoModeRunning: isAutoModeRunningForWorktree(selectedWorktree),
      isRunning: hasRunningFeatures(selectedWorktree),
      testRunning: isTestRunningForWorktree(selectedWorktree),
      testSessionInfo: getTestSessionInfo(selectedWorktree),
    };
  }, [
    selectedWorktree,
    isDevServerRunning,
    isDevServerStarting,
    getDevServerInfo,
    isAutoModeRunningForWorktree,
    hasRunningFeatures,
    isTestRunningForWorktree,
    getTestSessionInfo,
  ]);

  // Build trigger button with all indicators - memoized for performance
  const triggerButton = useMemo(
    () => (
      <Button
        variant={selectedWorktree && highlightTrigger ? 'default' : 'outline'}
        size="sm"
        className={cn(
          'h-7 px-3 gap-1.5 font-mono text-xs min-w-0',
          selectedWorktree &&
            highlightTrigger &&
            'bg-primary text-primary-foreground border-r-0 rounded-l-md rounded-r-none',
          selectedWorktree &&
            !highlightTrigger &&
            'bg-secondary/50 hover:bg-secondary border-r-0 rounded-l-md rounded-r-none',
          !selectedWorktree && 'bg-secondary/50 hover:bg-secondary rounded-md'
        )}
        disabled={isActivating}
      >
        {/* Running/Activating indicator */}
        {(selectedStatus.isRunning || isActivating) && (
          <Spinner
            size="xs"
            className="shrink-0"
            variant={selectedWorktree && highlightTrigger ? 'foreground' : 'primary'}
          />
        )}

        {/* Branch icon */}
        <GitBranch className="w-3.5 h-3.5 shrink-0" />

        {/* Branch name with optional tooltip */}
        <span className="truncate max-w-[150px]">{truncatedBranch}</span>

        {/* Card count badge */}
        {selectedWorktree &&
          branchCardCounts?.[selectedWorktree.branch] !== undefined &&
          branchCardCounts[selectedWorktree.branch] > 0 && (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-medium rounded bg-background/80 text-foreground border border-border shrink-0">
              {branchCardCounts[selectedWorktree.branch]}
            </span>
          )}

        {/* Uncommitted changes indicator */}
        {selectedWorktree?.hasChanges && (
          <span
            className={cn(
              'inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-medium rounded border shrink-0',
              getChangesBadgeStyles()
            )}
          >
            <CircleDot className="w-2.5 h-2.5 mr-0.5" />
            {selectedWorktree.changedFilesCount ?? '!'}
          </span>
        )}

        {/* Dev server indicator - only shown when port is confirmed detected */}
        {selectedStatus.devServerRunning && selectedStatus.devServerInfo?.urlDetected !== false && (
          <span
            className="inline-flex items-center justify-center h-4 w-4 text-green-500 shrink-0"
            title={`Dev server running on port ${selectedStatus.devServerInfo?.port}`}
          >
            <Globe className="w-3 h-3" />
          </span>
        )}

        {/* Dev server starting indicator */}
        {selectedStatus.devServerStarting && (
          <span
            className="inline-flex items-center justify-center h-4 w-4 text-amber-500 shrink-0"
            title="Dev server starting..."
          >
            <Spinner size="xs" variant="primary" />
          </span>
        )}

        {/* Test running indicator */}
        {selectedStatus.testRunning && (
          <span
            className="inline-flex items-center justify-center h-4 w-4 text-blue-500 shrink-0"
            title="Tests Running"
          >
            <FlaskConical className="w-3 h-3 animate-pulse" />
          </span>
        )}

        {/* Last test result indicator (when not running) */}
        {!selectedStatus.testRunning && selectedStatus.testSessionInfo && (
          <span
            className={cn(
              'inline-flex items-center justify-center h-4 w-4 shrink-0',
              getTestStatusStyles(selectedStatus.testSessionInfo.status)
            )}
            title={`Last test: ${selectedStatus.testSessionInfo.status}`}
          >
            <FlaskConical className="w-3 h-3" />
          </span>
        )}

        {/* Auto mode indicator */}
        {selectedStatus.autoModeRunning && (
          <span
            className="flex items-center justify-center h-4 px-0.5 shrink-0"
            title="Auto Mode Running"
          >
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          </span>
        )}

        {/* Conflict indicator */}
        {selectedWorktree?.hasConflicts && (
          <span
            className={cn(
              'inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-medium rounded border shrink-0',
              getConflictBadgeStyles()
            )}
            title={`${getConflictTypeLabel(selectedWorktree.conflictType)} conflicts detected`}
          >
            <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
            {getConflictTypeLabel(selectedWorktree.conflictType)}
          </span>
        )}

        {/* PR badge */}
        {selectedWorktree?.pr && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 h-4 px-1 text-[10px] font-medium rounded border shrink-0',
              getPRBadgeStyles(selectedWorktree.pr.state)
            )}
          >
            <GitPullRequest className="w-2.5 h-2.5" />#{selectedWorktree.pr.number}
          </span>
        )}

        {/* Dropdown chevron */}
        <ChevronDown className="w-3 h-3 shrink-0 ml-auto" />
      </Button>
    ),
    [
      isActivating,
      selectedStatus,
      truncatedBranch,
      selectedWorktree,
      branchCardCounts,
      highlightTrigger,
    ]
  );

  // Wrap trigger button with dropdown trigger first to ensure ref is passed correctly
  const dropdownTrigger = <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>;

  const triggerWithTooltip = isBranchNameTruncated ? (
    <Tooltip>
      <TooltipTrigger asChild>{dropdownTrigger}</TooltipTrigger>
      <TooltipContent>
        <p className="font-mono text-xs">{displayBranch}</p>
      </TooltipContent>
    </Tooltip>
  ) : (
    dropdownTrigger
  );

  return (
    <div className="flex items-center">
      <DropdownMenu
        onOpenChange={(open) => {
          // Start every visit with the full list
          if (!open) setSearchQuery('');
        }}
      >
        {triggerWithTooltip}
        <DropdownMenuContent
          align="start"
          className="w-80 max-h-96 overflow-y-auto"
          aria-label="Worktree selection"
        >
          {/* Keyword search - sticky so the filter stays reachable while scrolling */}
          <div className="sticky -top-1 z-10 -mx-1 -mt-1 border-b border-border/50 bg-popover px-3 pb-2 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  // The menu owns typeahead and Enter/Space selection. While the
                  // filter input is focused those keys belong to the input, but
                  // Escape must stay untouched so the menu can still be dismissed.
                  if (event.key !== 'Escape') event.stopPropagation();
                }}
                onKeyUp={(event) => event.stopPropagation()}
                placeholder="搜索分支 / 卡片 / PR…"
                aria-label="Search worktrees"
                className="h-7 pl-7 text-base md:text-xs"
                autoFocus
              />
            </div>
          </div>

          {/* Categorised list: 工作中 → 空闲 → 新增 → 已完成 */}
          {categoryGroups.map((group) => (
            <Fragment key={group.category}>
              <DropdownMenuLabel
                data-category={group.category}
                className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground"
                title={group.hint}
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full', group.dotClass)} />
                  {group.label}
                </span>
                <span className="font-normal tabular-nums">{group.worktrees.length}</span>
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                {group.worktrees.map((worktree) => (
                  <WorktreeDropdownItem
                    key={worktree.path}
                    worktree={worktree}
                    isSelected={isWorktreeSelected(worktree)}
                    isRunning={hasRunningFeatures(worktree)}
                    cardCount={branchCardCounts?.[worktree.branch]}
                    jiraType={jiraTypeByBranch[worktree.branch]}
                    devServerRunning={isDevServerRunning(worktree)}
                    devServerStarting={isDevServerStarting(worktree)}
                    devServerInfo={getDevServerInfo(worktree)}
                    isAutoModeRunning={isAutoModeRunningForWorktree(worktree)}
                    isTestRunning={isTestRunningForWorktree(worktree)}
                    testSessionInfo={getTestSessionInfo(worktree)}
                    onSelect={() => onSelectWorktree(worktree)}
                  />
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}

          {/* Empty states */}
          {categoryGroups.length === 0 && (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              {searchQuery.trim() ? '没有匹配的 worktree' : 'No worktrees available'}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Branch switch dropdown for main branch (only when main is selected) */}
      {selectedWorktree?.isMain && (
        <BranchSwitchDropdown
          worktree={selectedWorktree}
          isSelected={highlightTrigger}
          branches={branches}
          filteredBranches={filteredBranches}
          branchFilter={branchFilter}
          isLoadingBranches={isLoadingBranches}
          isSwitching={isSwitching}
          onOpenChange={onBranchDropdownOpenChange(selectedWorktree)}
          onFilterChange={onBranchFilterChange}
          onSwitchBranch={onSwitchBranch}
          onCreateBranch={onCreateBranch}
        />
      )}

      {/* Actions dropdown for the selected worktree */}
      {selectedWorktree && (
        <WorktreeActionsDropdown
          worktree={selectedWorktree}
          isSelected={highlightTrigger}
          aheadCount={aheadCount}
          behindCount={behindCount}
          hasRemoteBranch={hasRemoteBranch}
          trackingRemote={
            getTrackingRemote ? getTrackingRemote(selectedWorktree.path) : trackingRemote
          }
          isPulling={isPulling}
          isPushing={isPushing}
          isStartingAnyDevServer={isStartingAnyDevServer}
          isDevServerStarting={isDevServerStarting(selectedWorktree)}
          isDevServerRunning={isDevServerRunning(selectedWorktree)}
          devServerInfo={getDevServerInfo(selectedWorktree)}
          gitRepoStatus={gitRepoStatus}
          isLoadingGitStatus={isLoadingBranches}
          isAutoModeRunning={isAutoModeRunningForWorktree(selectedWorktree)}
          hasTestCommand={hasTestCommand}
          isStartingTests={isStartingTests}
          isTestRunning={isTestRunningForWorktree(selectedWorktree)}
          testSessionInfo={getTestSessionInfo(selectedWorktree)}
          remotes={remotesCache?.[selectedWorktree.path]}
          onOpenChange={onActionsDropdownOpenChange(selectedWorktree)}
          onPull={onPull}
          onPush={onPush}
          onPushNewBranch={onPushNewBranch}
          onPullWithRemote={onPullWithRemote}
          onPushWithRemote={onPushWithRemote}
          onOpenInEditor={onOpenInEditor}
          onOpenInIntegratedTerminal={onOpenInIntegratedTerminal}
          onOpenInExternalTerminal={onOpenInExternalTerminal}
          onViewChanges={onViewChanges}
          onViewCommits={onViewCommits}
          onDiscardChanges={onDiscardChanges}
          onCommit={onCommit}
          onCreatePR={onCreatePR}
          onChangePRNumber={onChangePRNumber}
          onAddressPRComments={onAddressPRComments}
          onAutoAddressPRComments={onAutoAddressPRComments}
          onResolveConflicts={onResolveConflicts}
          onMerge={onMerge}
          onDeleteWorktree={onDeleteWorktree}
          onStartDevServer={onStartDevServer}
          onStopDevServer={onStopDevServer}
          onOpenDevServerUrl={onOpenDevServerUrl}
          onViewDevServerLogs={onViewDevServerLogs}
          onRunInitScript={onRunInitScript}
          onToggleAutoMode={onToggleAutoMode}
          onStartTests={onStartTests}
          onStopTests={onStopTests}
          onViewTestLogs={onViewTestLogs}
          onStashChanges={onStashChanges}
          onViewStashes={onViewStashes}
          onCherryPick={onCherryPick}
          onAbortOperation={onAbortOperation}
          onContinueOperation={onContinueOperation}
          onCreateConflictResolutionFeature={onCreateConflictResolutionFeature}
          hasInitScript={hasInitScript}
          terminalScripts={terminalScripts}
          onRunTerminalScript={onRunTerminalScript}
          onEditScripts={onEditScripts}
          isSyncing={isSyncing}
          onSync={onSync}
          onSyncWithRemote={onSyncWithRemote}
          onSetTracking={onSetTracking}
          remotesWithBranch={remotesWithBranch}
        />
      )}
    </div>
  );
}
