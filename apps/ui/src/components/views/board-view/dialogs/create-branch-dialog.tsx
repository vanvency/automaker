import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createLogger } from '@automaker/utils/logger';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { getElectronAPI } from '@/lib/electron';
import { getHttpApiClient } from '@/lib/http-api-client';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, GitBranchPlus, Globe, RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import {
  StashConfirmDialog,
  type UncommittedChangesInfo,
  type StashConfirmAction,
} from './stash-confirm-dialog';
import { type BranchInfo } from '../worktree-panel/types';

interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  hasChanges?: boolean;
  changedFilesCount?: number;
}

const logger = createLogger('CreateBranchDialog');

interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktree: WorktreeInfo | null;
  onCreated: () => void;
}

export function CreateBranchDialog({
  open,
  onOpenChange,
  worktree,
  onCreated,
}: CreateBranchDialogProps) {
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseBranchPopoverOpen, setBaseBranchPopoverOpen] = useState(false);
  const baseBranchTriggerRef = useRef<HTMLButtonElement>(null);
  const draftWorktreeRef = useRef<string | null>(null);
  const [baseBranchTriggerWidth, setBaseBranchTriggerWidth] = useState<number>(0);

  // Stash confirmation state
  const [showStashConfirm, setShowStashConfirm] = useState(false);
  const [uncommittedChanges, setUncommittedChanges] = useState<UncommittedChangesInfo | null>(null);

  // Keep a ref in sync with baseBranch so fetchBranches can read the latest value
  // without needing it in its dependency array (which would cause re-fetch loops)
  const baseBranchRef = useRef<string>(baseBranch);
  useEffect(() => {
    baseBranchRef.current = baseBranch;
  }, [baseBranch]);

  const fetchBranches = useCallback(async () => {
    if (!worktree) return;

    setIsLoadingBranches(true);

    try {
      const api = getHttpApiClient();
      const result = await api.worktree.listBranches(worktree.path, true);

      if (result.success && result.result) {
        setBranches(result.result.branches);
        // Only set the default base branch if no branch is currently selected,
        // or if the currently selected branch is no longer present in the fetched list
        const branchNames = result.result.branches.map((b: BranchInfo) => b.name);
        const currentBaseBranch = baseBranchRef.current;
        if (!currentBaseBranch || !branchNames.includes(currentBaseBranch)) {
          if (result.result.currentBranch) {
            setBaseBranch(result.result.currentBranch);
          }
        }
      }
    } catch (err) {
      logger.error('Failed to fetch branches:', err);
    } finally {
      setIsLoadingBranches(false);
    }
  }, [worktree]);

  // Keep unfinished branch choices when the same worktree is reopened.
  useEffect(() => {
    if (open) {
      if (draftWorktreeRef.current !== worktree?.path) {
        draftWorktreeRef.current = worktree?.path ?? null;
        setBranchName('');
        setBaseBranch('');
        baseBranchRef.current = '';
      }
      setError(null);
      setBranches([]);
      setBaseBranchPopoverOpen(false);
      setShowStashConfirm(false);
      setUncommittedChanges(null);
      setIsChecking(false);
      fetchBranches();
    }
  }, [open, fetchBranches, worktree?.path]);

  // Track trigger width for popover sizing
  useEffect(() => {
    const el = baseBranchTriggerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setBaseBranchTriggerWidth(el.offsetWidth);
    });
    observer.observe(el);
    setBaseBranchTriggerWidth(el.offsetWidth);
    return () => observer.disconnect();
  }, [baseBranchPopoverOpen]);

  /**
   * Execute the actual branch creation, optionally with stash handling
   */
  const doCreate = useCallback(
    async (stashChanges: boolean) => {
      if (!worktree || !branchName.trim()) return;

      setIsCreating(true);
      setError(null);

      try {
        const api = getElectronAPI();
        if (!api?.worktree?.checkoutBranch) {
          toast.error('Branch API not available');
          setIsCreating(false);
          return;
        }

        const selectedBase = baseBranch || undefined;
        const result = await api.worktree.checkoutBranch(
          worktree.path,
          branchName.trim(),
          selectedBase,
          stashChanges,
          true // includeUntracked
        );

        if (result.success && result.result) {
          // Check if there were conflicts from stash reapply
          if (result.result.hasConflicts) {
            toast.warning('Branch created with conflicts', {
              description: result.result.message,
              duration: 8000,
            });
          } else {
            const desc = result.result.stashedChanges
              ? 'Local changes were stashed and reapplied'
              : undefined;
            toast.success(result.result.message, { description: desc });
          }
          onCreated();
          draftWorktreeRef.current = null;
          onOpenChange(false);
        } else {
          setError(result.error || 'Failed to create branch');
        }
      } catch (err) {
        logger.error('Create branch failed:', err);
        setError('Failed to create branch');
      } finally {
        setIsCreating(false);
        setShowStashConfirm(false);
      }
    },
    [worktree, branchName, baseBranch, onCreated, onOpenChange]
  );

  /**
   * Handle the initial "Create Branch" click.
   * Checks for uncommitted changes first and shows confirmation if needed.
   */
  const handleCreate = async () => {
    // Guard against concurrent invocations during the async pre-check or creation
    if (isCreating || isChecking) return;
    if (!worktree || !branchName.trim()) return;

    // Basic validation
    const invalidChars = /[\s~^:?*[\]\\]/;
    if (invalidChars.test(branchName)) {
      setError('Branch name contains invalid characters');
      return;
    }

    setError(null);
    setIsChecking(true);

    // Check for uncommitted changes before proceeding
    try {
      const api = getHttpApiClient();
      const changesResult = await api.worktree.checkChanges(worktree.path);

      if (changesResult.success && changesResult.result?.hasChanges) {
        // Show the stash confirmation dialog
        setUncommittedChanges({
          staged: changesResult.result.staged,
          unstaged: changesResult.result.unstaged,
          untracked: changesResult.result.untracked,
          totalFiles: changesResult.result.totalFiles,
        });
        setIsChecking(false);
        setShowStashConfirm(true);
        return;
      }
    } catch (err) {
      // If we can't check for changes, proceed without stashing
      logger.warn('Failed to check for uncommitted changes, proceeding without stash:', err);
    }

    setIsChecking(false);

    // No changes detected, proceed directly
    doCreate(false);
  };

  /**
   * Handle the user's decision in the stash confirmation dialog
   */
  const handleStashConfirmAction = useCallback(
    (action: StashConfirmAction) => {
      switch (action) {
        case 'stash-and-proceed':
          doCreate(true);
          break;
        case 'proceed-without-stash':
          doCreate(false);
          break;
        case 'cancel':
          setShowStashConfirm(false);
          break;
      }
    },
    [doCreate]
  );

  // Separate local and remote branches
  const localBranches = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);
  const remoteBranches = useMemo(() => branches.filter((b) => b.isRemote), [branches]);

  // Display label for the selected base branch
  const baseBranchDisplayLabel = useMemo(() => {
    if (!baseBranch) return null;
    const found = branches.find((b) => b.name === baseBranch);
    if (!found) return baseBranch;
    return found.isCurrent ? `${found.name} (current)` : found.name;
  }, [baseBranch, branches]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranchPlus className="w-5 h-5" />
              Create New Branch
            </DialogTitle>
            <DialogDescription>Create a new branch from a base branch</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="branch-name">Branch Name</Label>
              <Input
                id="branch-name"
                placeholder="feature/my-new-feature"
                value={branchName}
                onChange={(e) => {
                  setBranchName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && branchName.trim() && !isCreating && !isChecking) {
                    handleCreate();
                  }
                }}
                disabled={isCreating || isChecking}
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="base-branch">Base Branch</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={fetchBranches}
                  disabled={isLoadingBranches || isCreating}
                  className="h-6 px-2 text-xs"
                >
                  {isLoadingBranches ? (
                    <Spinner size="xs" className="mr-1" />
                  ) : (
                    <RefreshCw className="w-3 h-3 mr-1" />
                  )}
                  Refresh
                </Button>
              </div>
              {isLoadingBranches && branches.length === 0 ? (
                <div className="flex items-center justify-center py-3 border rounded-md border-input">
                  <Spinner size="sm" className="mr-2" />
                  <span className="text-sm text-muted-foreground">Loading branches...</span>
                </div>
              ) : (
                <Popover open={baseBranchPopoverOpen} onOpenChange={setBaseBranchPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="base-branch"
                      ref={baseBranchTriggerRef}
                      variant="outline"
                      role="combobox"
                      aria-expanded={baseBranchPopoverOpen}
                      disabled={isCreating}
                      className="w-full justify-between font-normal"
                    >
                      <span className="truncate text-sm">
                        {baseBranchDisplayLabel ?? (
                          <span className="text-muted-foreground">Select base branch</span>
                        )}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="p-0"
                    style={{ width: Math.max(baseBranchTriggerWidth, 200) }}
                    onWheel={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                  >
                    <Command shouldFilter={true}>
                      <CommandInput placeholder="Filter branches..." className="h-9" />
                      <CommandList>
                        <CommandEmpty>No matching branches</CommandEmpty>
                        {localBranches.length > 0 && (
                          <CommandGroup heading="Local Branches">
                            {localBranches.map((branch) => (
                              <CommandItem
                                key={branch.name}
                                value={branch.name}
                                onSelect={(value) => {
                                  setBaseBranch(value);
                                  setBaseBranchPopoverOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    'mr-2 h-4 w-4 shrink-0',
                                    baseBranch === branch.name ? 'opacity-100' : 'opacity-0'
                                  )}
                                />
                                <span className={cn('truncate', branch.isCurrent && 'font-medium')}>
                                  {branch.name}
                                </span>
                                {branch.isCurrent && (
                                  <span className="ml-1.5 text-xs text-muted-foreground shrink-0">
                                    (current)
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {remoteBranches.length > 0 && (
                          <>
                            {localBranches.length > 0 && <CommandSeparator />}
                            <CommandGroup heading="Remote Branches">
                              {remoteBranches.map((branch) => (
                                <CommandItem
                                  key={branch.name}
                                  value={branch.name}
                                  onSelect={(value) => {
                                    setBaseBranch(value);
                                    setBaseBranchPopoverOpen(false);
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      'mr-2 h-4 w-4 shrink-0',
                                      baseBranch === branch.name ? 'opacity-100' : 'opacity-0'
                                    )}
                                  />
                                  <Globe className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{branch.name}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating || isChecking}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!branchName.trim() || isCreating || isChecking}
            >
              {isCreating ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  Creating...
                </>
              ) : isChecking ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  Checking...
                </>
              ) : (
                'Create Branch'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stash confirmation dialog - shown when uncommitted changes are detected */}
      <StashConfirmDialog
        open={showStashConfirm}
        onOpenChange={setShowStashConfirm}
        operationDescription={`create branch '${branchName.trim()}'`}
        changesInfo={uncommittedChanges}
        onConfirm={handleStashConfirmAction}
        isLoading={isCreating}
      />
    </>
  );
}
