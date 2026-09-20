import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw, Terminal } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { withPageAuthParams } from '@/lib/api-fetch';
import { getHttpApiClient, getServerUrlSync } from '@/lib/http-api-client';
import { cn } from '@/lib/utils';

/**
 * Herdr preview view.
 *
 * The Agent sidebar entry is a live view of the herdr workspace that supervises
 * the current project/worktree. The server creates (or reuses) one attach PTY
 * for that workspace; this component embeds the hosted xterm.js client in an
 * iframe so the user gets the real herdr TUI, keybindings and status bar.
 */

interface HerdrPreviewState {
  sessionName: string;
  terminalSessionId: string;
  workDir: string;
  reused: boolean;
}

export function AgentView() {
  const { currentProject, getCurrentWorktree } = useAppStore();
  const currentWorktree = currentProject ? getCurrentWorktree(currentProject.path) : null;
  const workDir = currentWorktree?.path || currentProject?.path || null;

  const [preview, setPreview] = useState<HerdrPreviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Work directory of the last attach, so effect re-runs (including StrictMode's
  // double invoke) do not open a second PTY. Starts empty so the first mount
  // always attaches; Reconnect/Retry pass force to bypass it.
  const requestKey = useRef<string | null>(null);

  const loadPreview = useCallback(
    async (force = false) => {
      if (!currentProject?.path) return;
      if (!force && requestKey.current === workDir) return;
      requestKey.current = workDir;

      setLoading(true);
      setError(null);
      setPreview(null);
      try {
        const result = await getHttpApiClient().herdr.getPreview(
          currentProject.path,
          workDir ?? undefined
        );
        if (!result?.success || !result.terminalSessionId) {
          throw new Error(result?.error || 'Could not create the herdr preview');
        }
        setPreview({
          sessionName: result.sessionName ?? '',
          terminalSessionId: result.terminalSessionId,
          workDir: result.workDir ?? workDir ?? '',
          reused: result.reused ?? false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the herdr preview');
      } finally {
        setLoading(false);
      }
    },
    [currentProject?.path, workDir]
  );

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const iframeUrl = useMemo(() => {
    if (!preview) return '';
    const query = new URLSearchParams({
      session: preview.terminalSessionId,
      name: preview.sessionName,
      title: currentProject?.name || 'Agent',
      dir: preview.workDir,
      projectPath: currentProject?.path || '',
    });
    // Electron serves the renderer from its own static server, which does not
    // proxy /api - only the web build shares an origin with the server.
    const base = import.meta.env.VITE_SERVER_URL || getServerUrlSync() || window.location.origin;
    const url = new URL(`/api/herdr/view?${query}`, base);
    return withPageAuthParams(url).toString();
  }, [preview, currentProject?.name, currentProject?.path]);

  if (!currentProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="p-4 rounded-full bg-brand-500/10 mb-4">
          <Terminal className="h-12 w-12 text-brand-500" />
        </div>
        <h2 className="text-lg font-medium mb-2">Agent</h2>
        <p className="text-muted-foreground max-w-md">
          Select or create a project to preview its herdr workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="herdr-agent-preview">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-brand-500" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium truncate">Agent · {currentProject.name}</h2>
            <p className="text-xs text-muted-foreground truncate" title={workDir ?? undefined}>
              {preview?.sessionName || 'Connecting…'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {preview?.reused && (
            <span className="text-xs text-muted-foreground" data-testid="herdr-preview-reused">
              reused session
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => void loadPreview(true)}
            disabled={loading}
            data-testid="herdr-preview-retry"
          >
            {loading ? (
              <Spinner size="sm" className="mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Reconnect
          </Button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-background">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <Spinner size="xl" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center p-6 bg-background">
            <div className="p-4 rounded-full bg-destructive/10 mb-4">
              <AlertCircle className="h-12 w-12 text-destructive" />
            </div>
            <h2 className="text-lg font-medium mb-2">Agent Unavailable</h2>
            <p className="text-muted-foreground max-w-md mb-4">{error}</p>
            <Button variant="outline" onClick={() => void loadPreview(true)}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        )}

        {iframeUrl && (
          <iframe
            src={iframeUrl}
            title="Agent preview"
            className={cn(
              'w-full h-full border-0 bg-background',
              (loading || error) && 'invisible'
            )}
            data-testid="herdr-preview-frame"
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
