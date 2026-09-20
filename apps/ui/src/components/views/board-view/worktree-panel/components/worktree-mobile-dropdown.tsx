import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { GitBranch, ChevronDown, CircleDot, Check, Globe, Search } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { WorktreeInfo, DevServerInfo, FeatureInfo } from '../types';
import { useRecentWorktreesStore } from '@/store/recent-worktrees-store';
import { buildWorktreeCategoryGroups, withRecentWorktrees } from './worktree-category-utils';
import { JiraTypeBadge } from '../../components/jira-type-badge';

interface WorktreeMobileDropdownProps {
  worktrees: WorktreeInfo[];
  projectPath?: string;
  isWorktreeSelected: (worktree: WorktreeInfo) => boolean;
  hasRunningFeatures: (worktree: WorktreeInfo) => boolean;
  isDevServerRunning: (worktree: WorktreeInfo) => boolean;
  isDevServerStarting: (worktree: WorktreeInfo) => boolean;
  getDevServerInfo: (worktree: WorktreeInfo) => DevServerInfo | undefined;
  isActivating: boolean;
  branchCardCounts?: Record<string, number>;
  /** Board cards, used to categorise and search the worktree list */
  features?: FeatureInfo[];
  onSelectWorktree: (worktree: WorktreeInfo) => void;
}

export function WorktreeMobileDropdown({
  worktrees,
  projectPath,
  isWorktreeSelected,
  hasRunningFeatures,
  isDevServerRunning,
  isDevServerStarting,
  getDevServerInfo,
  isActivating,
  branchCardCounts,
  features,
  onSelectWorktree,
}: WorktreeMobileDropdownProps) {
  const recentPaths = useRecentWorktreesStore((state) =>
    projectPath ? state.pathsByProject[projectPath] : undefined
  );
  // Find the currently selected worktree to display in the trigger
  const selectedWorktree = worktrees.find((w) => isWorktreeSelected(w));
  const displayBranch = selectedWorktree?.branch || 'Select branch';

  // Keyword filter for the worktree list
  const [searchQuery, setSearchQuery] = useState('');

  // Jira work type per branch, taken from the cards of that worktree.
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
  // down by the keyword filter.
  const categoryGroups = useMemo(
    () =>
      withRecentWorktrees(
        buildWorktreeCategoryGroups(
          worktrees,
          { isRunning: hasRunningFeatures, features, cardCounts: branchCardCounts },
          searchQuery
        ),
        recentPaths
      ),
    [worktrees, hasRunningFeatures, features, branchCardCounts, searchQuery, recentPaths]
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Start every visit with the full list
        if (!open) setSearchQuery('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 gap-2 font-mono text-xs bg-secondary/50 hover:bg-secondary flex-1 min-w-0"
          disabled={isActivating}
        >
          <GitBranch className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{displayBranch}</span>
          {isActivating ? (
            <Spinner size="xs" className="shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 shrink-0 ml-auto" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
        {/* Keyword search - sticky so the filter stays reachable while scrolling */}
        <div className="sticky -top-1 z-10 -mx-1 -mt-1 border-b border-border/50 bg-popover px-3 pb-2 pt-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                // Keep typing local to the filter, but leave Escape alone so the
                // menu can still be dismissed from the input.
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              onKeyUp={(event) => event.stopPropagation()}
              placeholder="搜索分支 / 卡片…"
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
              {group.worktrees.map((worktree) => {
                const isSelected = isWorktreeSelected(worktree);
                const isRunning = hasRunningFeatures(worktree);
                const devServerRunning = isDevServerRunning(worktree);
                const devServerStarting = isDevServerStarting(worktree);
                const devServerInfo = getDevServerInfo(worktree);
                const cardCount = branchCardCounts?.[worktree.branch];
                const hasChanges = worktree.hasChanges;
                const changedFilesCount = worktree.changedFilesCount;

                return (
                  <DropdownMenuItem
                    key={worktree.path}
                    onSelect={() => onSelectWorktree(worktree)}
                    className={cn(
                      'flex items-center gap-2 cursor-pointer',
                      isSelected && 'bg-accent'
                    )}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {isSelected ? (
                        <Check className="w-3.5 h-3.5 shrink-0 text-primary" />
                      ) : (
                        <div className="w-3.5 h-3.5 shrink-0" />
                      )}
                      {isRunning && <Spinner size="xs" className="shrink-0" />}
                      <JiraTypeBadge
                        type={jiraTypeByBranch[worktree.branch]}
                        data-testid={`mobile-worktree-jira-type-${worktree.branch}`}
                      />
                      <span
                        className={cn('font-mono text-xs truncate', isSelected && 'font-medium')}
                      >
                        {worktree.branch}
                      </span>
                      {worktree.isMain && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                          main
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {cardCount !== undefined && cardCount > 0 && (
                        <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-[10px] font-medium rounded bg-background/80 text-foreground border border-border">
                          {cardCount}
                        </span>
                      )}
                      {hasChanges && (
                        <span
                          className={cn(
                            'inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-[10px] font-medium rounded border',
                            'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30'
                          )}
                          title={`${changedFilesCount ?? 'Some'} uncommitted file${changedFilesCount !== 1 ? 's' : ''}`}
                        >
                          <CircleDot className="w-2.5 h-2.5 mr-0.5" />
                          {changedFilesCount ?? '!'}
                        </span>
                      )}
                      {devServerRunning && devServerInfo?.urlDetected === true && (
                        <Globe className="w-3 h-3 text-green-500" />
                      )}
                      {devServerStarting && <Spinner size="xs" variant="muted" />}
                    </div>
                  </DropdownMenuItem>
                );
              })}
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
  );
}
