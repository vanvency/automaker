import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, RefreshCw, Rocket, Square } from 'lucide-react';
import { toast } from 'sonner';
import { getElectronAPI } from '@/lib/electron';
import { Button } from '@/components/ui/button';
import type { WorktreePreviewResponse } from '@automaker/types';

/** Always visible above the board, even when its worktree selector is collapsed. */
export function BoardWorktreePreview({
  projectPath,
  worktreePath,
  branch,
}: {
  projectPath: string;
  worktreePath: string;
  branch: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border/50 px-3 py-2"
      data-testid="board-worktree-preview"
    >
      <span className="text-xs text-muted-foreground">
        Feature Preview · <span className="font-mono">{branch}</span>
      </span>
      <WorktreePreviewControls
        key={`${projectPath}:${worktreePath}`}
        projectPath={projectPath}
        worktreePath={worktreePath}
      />
    </div>
  );
}

/** Shared by the board and table; the query key isolates each worktree. */
export function WorktreePreviewControls({
  projectPath,
  worktreePath,
}: {
  projectPath: string;
  worktreePath: string;
}) {
  const client = useQueryClient();
  const queryKey = ['worktree-preview', projectPath, worktreePath];
  const api = getElectronAPI().worktree;
  const query = useQuery<WorktreePreviewResponse>({
    queryKey,
    queryFn: async () => {
      if (!api) throw new Error('Preview API is unavailable');
      const result = await api.previewStatus(projectPath, worktreePath);
      if (!result.success) throw new Error(result.error || 'Could not read preview status');
      return result;
    },
    enabled: !!api?.previewStatus,
    refetchInterval: (query) =>
      ['deploying', 'stopping'].includes(query.state.data?.preview?.status ?? '') ? 2000 : 15000,
  });
  const mutation = useMutation({
    mutationFn: async (action: 'start' | 'stop') => {
      if (!api) throw new Error('Preview API is unavailable');
      const result = await (action === 'start' ? api.previewStart : api.previewStop)(
        projectPath,
        worktreePath
      );
      if (!result.success) throw new Error(result.error || 'Preview operation failed');
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  if (!api?.previewStatus) return null;
  const preview = query.data?.preview;
  const busy =
    mutation.isPending || preview?.status === 'deploying' || preview?.status === 'stopping';
  const ready = preview?.status === 'ready' && !!preview.url && /^https?:\/\//.test(preview.url);
  const labels = {
    deploying: 'Deploying…',
    stopping: 'Stopping…',
    stopped: 'Stopped',
    ready: 'Preview ready',
    unavailable: 'Preview unavailable',
    failed: 'Deployment failed',
  };
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-[11px]"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="worktree-preview"
    >
      {query.isPending && <span className="truncate text-muted-foreground">Loading preview…</span>}
      {query.error && (
        <span className="truncate text-destructive" title={query.error.message}>
          Could not read preview status
        </span>
      )}
      {query.data?.error && (
        <span className="w-full break-words text-destructive">{query.data.error}</span>
      )}
      {query.data && !query.data.configured && !preview && (
        <span
          className="truncate text-muted-foreground"
          title="Configure .automaker/preview.json in the project; see docs/worktree-previews.md"
        >
          Preview not configured
        </span>
      )}
      {preview && (
        <span
          className="min-w-0 truncate text-muted-foreground"
          title={preview.error || preview.updatedAt}
        >
          {busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
          {labels[preview.status]}
        </span>
      )}
      {/* Actions stay icons so a worktree card reads as one compact row. */}
      {ready && (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open Preview"
          title={`Open Preview · ${preview.url}`}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-brand-500 hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
      {query.data?.configured && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0"
          disabled={busy}
          onClick={() => mutation.mutate('start')}
          aria-label={preview && preview.status !== 'stopped' ? 'Redeploy' : 'Deploy Preview'}
          title={preview && preview.status !== 'stopped' ? 'Redeploy preview' : 'Deploy preview'}
        >
          {preview && preview.status !== 'stopped' ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      {preview && preview.status !== 'stopped' && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0"
          disabled={busy}
          onClick={() => mutation.mutate('stop')}
          aria-label="Stop Preview"
          title="Stop preview"
        >
          <Square className="h-3 w-3" />
        </Button>
      )}
      {preview?.error && (
        <span className="w-full break-words text-destructive">{preview.error}</span>
      )}
    </div>
  );
}
