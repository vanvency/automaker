import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Rocket,
  Power,
  ScrollText,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import { getElectronAPI } from '@/lib/electron';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { WorktreePreviewResponse } from '@automaker/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type LogEntry = NonNullable<NonNullable<WorktreePreviewResponse['preview']>['logs']>[number];

function groupSteps(logs: LogEntry[]): LogEntry[] {
  return logs.reduce<LogEntry[]>((rows, entry) => {
    const previous = rows.at(-1);
    if (previous?.step === entry.step && previous.status === 'running') {
      rows[rows.length - 1] = { ...previous, ...entry };
    } else {
      rows.push(entry);
    }
    return rows;
  }, []);
}

/** Always visible above the board, even when its worktree selector is collapsed. */
export function BoardWorktreePreview({
  projectPath,
  worktreePath,
  inline = false,
}: {
  projectPath: string;
  worktreePath: string;
  branch: string;
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? 'flex flex-wrap items-center justify-end gap-x-2 gap-y-1'
          : 'flex flex-wrap items-center justify-end gap-3 border-b border-border/50 px-3 py-2'
      }
      data-testid="board-worktree-preview"
    >
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
  const [logsOpen, setLogsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configContent, setConfigContent] = useState('');
  const [configRevision, setConfigRevision] = useState('');
  const [configError, setConfigError] = useState('');
  const [componentFilter, setComponentFilter] = useState('');
  const queryKey = ['worktree-preview', projectPath, worktreePath];
  const api = getElectronAPI().worktree;
  const configKey = ['project-preview-config', projectPath];
  const configQuery = useQuery({
    queryKey: configKey,
    queryFn: async () => {
      if (!api) throw new Error('Preview API is unavailable');
      const result = await api.previewConfigRead(projectPath);
      if (!result.success) throw new Error(result.error || 'Could not read preview configuration');
      return result;
    },
    enabled: configOpen,
  });
  useEffect(() => {
    if (configQuery.data) {
      setConfigContent(configQuery.data.content || '');
      setConfigRevision(configQuery.data.revision || '');
    }
  }, [configQuery.data]);
  const saveConfig = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error('Preview API is unavailable');
      const result = await api.previewConfigSave(projectPath, configContent, configRevision);
      if (!result.success) throw new Error(result.error || 'Could not save preview configuration');
      return result;
    },
    onSuccess: () => {
      setConfigOpen(false);
      setConfigError('');
      toast.success('Preview configuration saved. Redeploy to apply it.');
      void client.invalidateQueries({ queryKey: configKey });
      void client.invalidateQueries({ queryKey });
    },
    onError: (error) => setConfigError(error.message),
  });
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
      logsOpen || ['deploying', 'stopping'].includes(query.state.data?.preview?.status ?? '')
        ? 2000
        : 15000,
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
    onSuccess: (result) => {
      client.setQueryData<WorktreePreviewResponse>(queryKey, (previous) => ({
        ...previous,
        ...result,
        configured: previous?.configured,
      }));
      void client.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey });
    },
  });
  if (!api?.previewStatus) return null;
  const preview = query.data?.preview;
  const deploymentStartedAt =
    preview?.deploymentStartedAt ??
    preview?.logs?.findLast(
      (entry) => entry.step === 'Validate preview namespace' && entry.status === 'running'
    )?.at;
  const busy =
    mutation.isPending || preview?.status === 'deploying' || preview?.status === 'stopping';
  const ready = preview?.status === 'ready' && !!preview.url && /^https?:\/\//.test(preview.url);
  const failed =
    !!query.error ||
    !!query.data?.error ||
    !!mutation.error ||
    preview?.status === 'failed' ||
    preview?.status === 'unavailable';
  const lamp = failed
    ? 'bg-red-500'
    : busy
      ? 'bg-amber-500 animate-pulse'
      : ready
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/50';
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
      <span
        role="img"
        aria-label={`Preview status: ${failed ? 'error' : busy ? 'working' : ready ? 'ready' : 'inactive'}`}
        className={`h-2 w-2 shrink-0 rounded-full ${lamp}`}
      />
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
      {query.data?.configured && !preview && (
        <span className="text-muted-foreground">Preview not deployed</span>
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
      {deploymentStartedAt && (
        <time
          className="text-muted-foreground"
          dateTime={deploymentStartedAt}
          title={`最近部署开始：${new Date(deploymentStartedAt).toLocaleString()}${preview?.deployedAt ? `；就绪：${new Date(preview.deployedAt).toLocaleString()}` : ''}`}
        >
          最近部署：{new Date(deploymentStartedAt).toLocaleString()}
        </time>
      )}
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
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          disabled={busy}
          onClick={() => {
            setLogsOpen(true);
            setComponentFilter('');
            mutation.mutate('start');
          }}
          aria-label={preview && preview.status !== 'stopped' ? 'Redeploy' : 'Deploy Preview'}
          title={preview && preview.status !== 'stopped' ? 'Redeploy preview' : 'Deploy preview'}
        >
          {preview && preview.status !== 'stopped' ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          {preview && preview.status !== 'stopped' ? 'Redeploy' : 'Deploy Preview'}
        </Button>
      )}
      {preview && preview.status !== 'stopped' && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          disabled={busy}
          onClick={() => {
            setLogsOpen(true);
            mutation.mutate('stop');
          }}
          aria-label="Stop Preview"
          title="Stop preview"
        >
          <Power className="h-3 w-3" />
          Stop Preview
        </Button>
      )}
      {preview?.error && (
        <span className="w-full break-words text-destructive">{preview.error}</span>
      )}
      {(preview || mutation.isPending || mutation.error) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => setLogsOpen(true)}
        >
          <ScrollText className="h-3.5 w-3.5" /> Deployment logs
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-[11px]"
        onClick={() => {
          setConfigError('');
          setConfigOpen(true);
          void client.invalidateQueries({ queryKey: configKey });
        }}
        aria-label="Edit project preview configuration"
      >
        <Settings2 className="h-3.5 w-3.5" /> Preview config
      </Button>
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Project preview configuration</DialogTitle>
            <DialogDescription>
              Edit .automaker/preview.json for this project. All task worktrees inherit it. Redeploy
              to apply saved changes.
            </DialogDescription>
          </DialogHeader>
          {configQuery.isPending ? (
            <p>Loading configuration…</p>
          ) : configQuery.error ? (
            <p role="alert" className="text-destructive">
              {configQuery.error.message}
            </p>
          ) : (
            <>
              <label htmlFor="project-preview-json" className="text-sm font-medium">
                Preview JSON
              </label>
              <Textarea
                id="project-preview-json"
                value={configContent}
                onChange={(event) => setConfigContent(event.target.value)}
                className="min-h-64 max-h-[55vh] font-mono text-xs"
                spellCheck={false}
              />
              {configError && (
                <p role="alert" className="text-destructive">
                  {configError}
                </p>
              )}
              <Button
                disabled={saveConfig.isPending}
                onClick={() => {
                  setConfigError('');
                  saveConfig.mutate();
                }}
              >
                {saveConfig.isPending ? 'Saving…' : 'Save configuration'}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Deployment logs</DialogTitle>
            <DialogDescription>
              Commands, exit status and bounded, redacted output. Expand a step for details.
            </DialogDescription>
          </DialogHeader>
          <p role="status" className="text-sm">
            {mutation.isPending
              ? mutation.variables === 'stop'
                ? 'Requesting stop…'
                : 'Requesting deployment…'
              : preview
                ? labels[preview.status]
                : 'No deployment'}
          </p>
          {(mutation.error || query.error || query.data?.error || preview?.error) && (
            <p role="alert" className="break-words text-sm text-destructive">
              {mutation.error?.message ||
                query.error?.message ||
                query.data?.error ||
                preview?.error}
            </p>
          )}
          {preview?.devbridgeConfigError && (
            <p role="alert" className="text-sm text-destructive">
              {preview.devbridgeConfigError}
            </p>
          )}
          {preview?.devbridgeConfig ? (
            <details open className="rounded border border-border p-3 text-sm">
              <summary className="cursor-pointer font-semibold">
                Devbridge component configuration
              </summary>
              <p className="mt-2 break-words text-xs text-muted-foreground">
                Deployment snapshot: {preview.devbridgeConfig.configFile} ·{' '}
                {new Date(preview.devbridgeConfig.capturedAt).toLocaleString()}
                <br />
                Source root: {preview.devbridgeConfig.sourceRoot}
                <br />
                Gateway prefix removed: {preview.devbridgeConfig.stripPrefix || 'None'}
                <br />
                Namespace: {preview.devbridgeConfig.namespace} · Gateway:{' '}
                {preview.devbridgeConfig.gateway}
                <br />
                Proxy listen: {preview.devbridgeConfig.listen} · Auto reattach:{' '}
                {preview.devbridgeConfig.autoReattach
                  ? `enabled (${preview.devbridgeConfig.maxAttempts} attempts)`
                  : 'disabled'}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Component Git changes include committed, staged, unstaged and untracked files.
                Shared dependency changes outside a component directory are not attributed.
                Environment values and devbridge internal command arguments are hidden. All
                configured components participate in deployment.
              </p>
              {[...preview.devbridgeConfig.components]
                .sort(
                  (a, b) =>
                    ['changed', 'unknown', 'unchanged'].indexOf(a.changeStatus) -
                    ['changed', 'unknown', 'unchanged'].indexOf(b.changeStatus)
                )
                .map((component) => (
                  <details
                    key={component.name}
                    open={component.changeStatus !== 'unchanged'}
                    className="mt-3 rounded bg-muted/30 p-3"
                  >
                    <summary className="cursor-pointer font-medium">
                      {component.name} ·{' '}
                      {component.changeStatus === 'changed'
                        ? `${component.changedFiles} changed files`
                        : component.changeStatus === 'unknown'
                          ? 'Change scope unknown'
                          : 'No detected changes'}
                    </summary>
                    <dl className="mt-3 space-y-2 break-words text-xs">
                      {[
                        [
                          'Component config',
                          component.configFile || preview.devbridgeConfig!.configFile,
                        ],
                        ['Source directory', component.dir],
                        [
                          'Git baseline',
                          component.baseRef || 'Unavailable; only working changes could be checked',
                        ],
                        ['Target workload', component.target],
                        [
                          'Ports (local → remote)',
                          `${component.localPort} → ${component.remotePort}`,
                        ],
                        ['Route prefixes', component.routes.join(', ') || 'None'],
                        ['Health path', component.healthPath],
                        ['Build tool', component.buildTool],
                        [
                          'Environment keys (values hidden)',
                          component.environmentKeys.join(', ') || 'None',
                        ],
                      ].map(([label, value]) => (
                        <div key={label} className="grid gap-1 sm:grid-cols-[11rem_1fr]">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="min-w-0 break-all font-mono">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ))}
            </details>
          ) : (
            preview?.devbridge && (
              <p className="text-xs text-muted-foreground">
                No component configuration snapshot yet. New deployments using devbridge 0.3.2 or
                newer record it before prerequisite checks.
              </p>
            )
          )}
          {preview?.devbridgeConfig && (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              Filter component steps
              <select
                value={componentFilter}
                onChange={(event) => setComponentFilter(event.target.value)}
                className="min-w-0 rounded border border-input bg-background p-2"
              >
                <option value="">All deployment steps</option>
                {preview.devbridgeConfig.components.map((component) => (
                  <option key={component.name} value={component.name}>
                    {component.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ol
            aria-label="Deployment steps"
            className="max-h-[55vh] space-y-1 overflow-y-auto text-xs"
          >
            {groupSteps(
              preview?.logs?.filter(
                (entry) =>
                  !componentFilter || entry.step.startsWith(`Devbridge · ${componentFilter}:`)
              ) ?? []
            ).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="rounded border border-border px-2 py-1.5">
                <details open={entry.status === 'failed'}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
                    <time dateTime={entry.at} className="shrink-0 text-muted-foreground">
                      {new Date(entry.at).toLocaleTimeString()}
                    </time>
                    <strong className="min-w-0 flex-1 truncate">{entry.step}</strong>
                    <span
                      className={
                        entry.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      }
                    >
                      {entry.exitCode === undefined
                        ? entry.status
                        : `${entry.status} · exit ${entry.exitCode ?? 'unknown'}`}
                    </span>
                  </summary>
                  <div className="mt-1 space-y-1 break-words pl-1">
                    {entry.command && (
                      <code className="block whitespace-pre-wrap break-all font-mono">
                        $ {entry.command}
                      </code>
                    )}
                    {entry.output && (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono">
                        {entry.output}
                      </pre>
                    )}
                    <p
                      className={
                        entry.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      }
                    >
                      {entry.message}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {componentFilter &&
            !preview?.logs?.some((entry) =>
              entry.step.startsWith(`Devbridge · ${componentFilter}:`)
            ) && (
              <p className="text-sm text-muted-foreground">
                No steps recorded for this component yet.
              </p>
            )}
          {!preview?.logs?.length && (
            <p className="text-sm text-muted-foreground">
              {busy
                ? 'Waiting for deployment steps…'
                : 'No step logs recorded for this deployment. New deployments will record each step.'}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
