/**
 * Herdr task status badge.
 *
 * Shows the live leader/worker state of a feature that has been dispatched
 * through the shared `automaker` herdr session. The badge is small on purpose -
 * it is a status indicator, not a control surface; clicking it opens the herdr
 * terminal through the existing card action.
 */

import { memo, useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getElectronAPI } from '@/lib/electron';
import { Bot, Loader2, OctagonAlert } from 'lucide-react';

export interface HerdrTaskAgentStatus {
  paneId: string;
  name: string | null;
  agent: string | null;
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
}

export interface HerdrTaskStatus {
  workspaceId: string;
  label: string;
  leaderPaneId: string | null;
  agents: HerdrTaskAgentStatus[];
}

interface HerdrStatusBadgeProps {
  projectPath: string;
  featureId: string;
  /** Poll interval while the task is running; defaults to 5s */
  pollIntervalMs?: number;
}

/** Aggregate agent statuses into one badge state */
function summarize(status: HerdrTaskStatus): {
  kind: 'working' | 'blocked' | 'idle' | 'unknown';
  label: string;
} {
  const agents = status.agents;
  if (agents.some((agent) => agent.status === 'blocked')) {
    return { kind: 'blocked', label: 'Agent waiting for input' };
  }
  if (agents.some((agent) => agent.status === 'working')) {
    return { kind: 'working', label: 'Agent working' };
  }
  if (
    agents.length > 0 &&
    agents.every((agent) => agent.status === 'idle' || agent.status === 'done')
  ) {
    return { kind: 'idle', label: 'Agents idle' };
  }
  return { kind: 'unknown', label: 'Agent status unknown' };
}

export const HerdrStatusBadge = memo(function HerdrStatusBadge({
  projectPath,
  featureId,
  pollIntervalMs = 5000,
}: HerdrStatusBadgeProps) {
  const [status, setStatus] = useState<HerdrTaskStatus | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const api = getElectronAPI();
        const getHerdrTask = api.features?.getHerdrTask;
        if (!getHerdrTask) {
          setVisible(false);
          return;
        }
        const result = await getHerdrTask(projectPath, featureId);
        if (cancelled) return;
        if (result?.success && result.status) {
          setStatus(result.status);
          setVisible(true);
        } else {
          // No herdr workspace on this feature yet - nothing to show.
          setStatus(null);
          setVisible(false);
        }
      } catch {
        if (!cancelled) {
          // A transient error does not unmount the badge; the next poll may
          // recover once the session is reachable again.
          setVisible(status !== null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, pollIntervalMs);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `status` is intentionally not a dependency: it only affects the error
    // path's visibility fallback, and including it would restart the poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, featureId, pollIntervalMs]);

  if (!visible || !status) {
    return null;
  }

  const summary = summarize(status);
  const leader = status.agents.find((agent) => agent.paneId === status.leaderPaneId);
  const workers = status.agents.filter((agent) => agent.paneId !== status.leaderPaneId);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'inline-flex items-center justify-center w-6 h-6 rounded-md border-[1.5px]',
            summary.kind === 'working' && 'bg-blue-500/15 border-blue-500/40 text-blue-500',
            summary.kind === 'blocked' && 'bg-orange-500/15 border-orange-500/40 text-orange-500',
            summary.kind === 'idle' && 'bg-emerald-500/15 border-emerald-500/40 text-emerald-500',
            summary.kind === 'unknown' && 'bg-muted border-border text-muted-foreground'
          )}
          data-testid={`herdr-status-badge-${featureId}`}
        >
          {summary.kind === 'working' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : summary.kind === 'blocked' ? (
            <OctagonAlert className="w-3.5 h-3.5" />
          ) : (
            <Bot className="w-3.5 h-3.5" />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs max-w-[280px]">
        <p className="font-medium mb-1">{summary.label}</p>
        <div className="space-y-0.5">
          {leader && <p>leader · {leader.status}</p>}
          {workers.map((worker) => (
            <p key={worker.paneId}>
              {worker.name ?? worker.paneId} · {worker.status}
            </p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});
