/**
 * MR conflict notice for the Done lane.
 *
 * A verified card can only be completed once its delivery merge requests are
 * mergeable, and GitLab is the only place that knows a branch conflicts. The
 * card therefore asks the server for the conflicting merge requests and, when
 * there are any, shows them together with one button that hands the fix to the
 * agents of the tasks that own those repositories.
 */

import { memo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';

interface MergeConflict {
  name: string;
  mrUrl: string;
  iid: number;
  sourceBranch: string;
  targetBranch: string;
}

/** A conflict is a delivery state, not a live one: one check per minute is enough. */
const CONFLICT_STALE_MS = 60_000;

/** Stop the card's click-to-open-details handler from swallowing the interaction. */
const swallow = (event: { stopPropagation: () => void }) => event.stopPropagation();

export const MrConflictNotice = memo(function MrConflictNotice({
  projectPath,
  featureId,
  onDispatched,
}: {
  projectPath: string;
  featureId: string;
  /** Called after the conflict fix has been handed to the agents */
  onDispatched?: () => void;
}) {
  const queryClient = useQueryClient();
  const conflicts = useQuery({
    queryKey: queryKeys.features.mergeConflicts(projectPath, featureId),
    queryFn: async (): Promise<MergeConflict[]> => {
      const getMergeConflicts = getElectronAPI().features?.getMergeConflicts;
      if (!getMergeConflicts) return [];
      const result = await getMergeConflicts(projectPath, featureId);
      return result?.success ? (result.conflicts ?? []) : [];
    },
    enabled: !!projectPath && !!featureId,
    staleTime: CONFLICT_STALE_MS,
    retry: false,
  });
  const dispatch = useMutation({
    mutationFn: async () => {
      const resolveConflicts = getElectronAPI().features?.resolveConflicts;
      if (!resolveConflicts) throw new Error('当前版本不支持派发冲突修复');
      const result = await resolveConflicts(projectPath, featureId);
      if (!result?.success) throw new Error(result?.error || '派发冲突修复失败');
      return result.dispatched ?? [];
    },
    onSuccess: (dispatched) => {
      const repositories = dispatched.flatMap((item) => item.repositories);
      toast.success('已派发冲突修复', {
        description: repositories.length
          ? `交给 Agent 处理：${repositories.join('、')}`
          : 'Agent 正在处理 MR 冲突',
      });
      // The owning task starts running, so the board has to re-read its cards.
      void queryClient.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
      onDispatched?.();
    },
    onError: (error) => toast.error('派发冲突修复失败', { description: (error as Error).message }),
  });

  const list = conflicts.data ?? [];
  if (list.length === 0) return null;

  return (
    <div
      className="mb-2 rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error-bg)] px-2 py-1.5 text-[var(--status-error)]"
      data-testid={`mr-conflict-${featureId}`}
      onClick={swallow}
      onPointerDown={swallow}
    >
      <span className="flex items-start gap-1.5">
        <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
        <span className="text-[10px] leading-relaxed">
          交付 MR 存在合并冲突，暂时无法 Complete：
          {list.map((conflict, index) => (
            <span key={conflict.mrUrl}>
              {index > 0 && '、'}
              <a
                className="underline"
                href={conflict.mrUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`${conflict.sourceBranch} → ${conflict.targetBranch}`}
                onClick={swallow}
              >
                {conflict.name} !{conflict.iid}
              </a>
            </span>
          ))}
        </span>
      </span>
      <Button
        variant="destructive"
        size="sm"
        className="mt-1.5 h-6 w-full px-2 text-[10px]"
        disabled={dispatch.isPending}
        onClick={(event) => {
          event.stopPropagation();
          dispatch.mutate();
        }}
        onPointerDown={swallow}
        data-testid={`resolve-conflicts-${featureId}`}
        title="让 Agent 合并目标分支、解决冲突并推送"
      >
        {dispatch.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Wrench className="mr-1 h-3 w-3" />
        )}
        让 Agent 修复冲突
      </Button>
    </div>
  );
});
