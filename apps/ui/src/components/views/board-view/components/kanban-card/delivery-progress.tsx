import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { FeatureDelivery, DeliveryStepId } from '@automaker/types';
import { apiFetch } from '@/lib/api-fetch';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const labels: Record<DeliveryStepId, string> = {
  merge: 'MR 合并',
  jira: 'Jira 关闭',
  preview: '预览释放',
};
const states = {
  pending: '等待',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '无需执行 / 已保留',
};
export function DeliveryProgress({
  featureId,
  projectPath,
  initial,
  onRetry,
}: {
  featureId: string;
  projectPath: string;
  initial?: FeatureDelivery;
  onRetry?: () => void;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<DeliveryStepId | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const query = useQuery({
    queryKey: ['delivery-progress', projectPath, featureId],
    queryFn: async () => {
      const response = await apiFetch('/api/features/completion-progress', 'POST', {
        body: { projectPath, featureId },
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '无法读取交付进度');
      return result.progress as FeatureDelivery | null;
    },
    initialData: initial,
    refetchInterval: (query) =>
      query.state.data?.status === 'succeeded'
        ? false
        : query.state.data?.status === 'running'
          ? 1500
          : 5000,
    retry: false,
  });
  const progress = query.data ?? initial;
  useEffect(() => {
    if (progress?.status === 'succeeded')
      void client.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
  }, [progress?.status, client, projectPath]);
  const storedStep = progress?.steps.find((item) => item.id === selected);
  const step =
    storedStep && progress?.reconciliationError?.stepId === selected
      ? { ...storedStep, status: 'failed' as const, message: progress.reconciliationError.message }
      : storedStep;
  const send = async () => {
    if (!step || sending || sent) return;
    setSending(true);
    try {
      const response = await apiFetch('/api/features/completion-repair', 'POST', {
        body: { projectPath, featureId, stepId: step.id, instruction },
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '修复请求发送失败');
      setSent(true);
      toast.success('已请求 Agent 修复，请在 Agent 中查看处理结果');
      void client.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };
  if (!progress) return null;
  return (
    <section
      className="mb-3 space-y-2 rounded border p-2"
      data-testid={`delivery-progress-${featureId}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 text-xs font-medium">
        {progress.status === 'running' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : progress.status === 'failed' ? (
          <AlertTriangle className="h-3 w-3 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-green-600" />
        )}
        {progress.status === 'running'
          ? 'Complete 进行中'
          : progress.status === 'failed'
            ? 'Complete 需要处理'
            : 'Complete 已完成'}
      </div>
      <div className="grid grid-cols-3 gap-1" aria-label="交付三步进度">
        {progress.steps.map((item) => (
          <button
            type="button"
            key={item.id}
            className="min-w-0 space-y-1 text-left text-[10px]"
            title={`${labels[item.id]} · ${states[item.status]}${item.message ? `：${item.message}` : ''}`}
            aria-label={`${labels[item.id]}：${states[item.status]}`}
            onClick={() => {
              setSelected(item.id);
              setInstruction('');
              setSent(false);
            }}
          >
            <span
              className={cn(
                'block h-2 rounded',
                item.status === 'failed'
                  ? 'bg-destructive'
                  : item.status === 'running'
                    ? 'animate-pulse bg-brand-500'
                    : item.status === 'succeeded'
                      ? 'bg-green-500'
                      : item.status === 'skipped'
                        ? 'bg-sky-400'
                        : 'bg-muted'
              )}
            />
            <span className="block truncate">{labels[item.id]}</span>
          </button>
        ))}
      </div>
      {progress.reconciliationError && (
        <button
          className="text-xs text-destructive underline"
          onClick={() => {
            setSelected(progress.reconciliationError!.stepId);
            setSent(false);
          }}
        >
          重试核对失败 · 查看原因
        </button>
      )}
      {query.isError && (
        <p className="text-[10px] text-destructive">进度刷新失败，正在显示上次记录。</p>
      )}
      {progress.status === 'failed' && onRetry && (
        <Button size="sm" variant="outline" className="h-7 w-full text-xs" onClick={onRetry}>
          核对并重试 Complete
        </Button>
      )}
      <Dialog
        open={!!step}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{step ? labels[step.id] : '交付步骤'}</DialogTitle>
            <DialogDescription>
              {step ? states[step.status] : ''} · 已完成步骤会保留，重试先核对实际状态。
            </DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap break-words text-sm">
            {step?.message || '此步骤尚未执行。'}
          </p>
          {step?.status === 'failed' && (
            <>
              <textarea
                aria-label="给 Agent 的修复请求"
                placeholder="补充你希望 Agent 排查或修复的内容（可选）"
                maxLength={8000}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                className="min-h-24 rounded border bg-background p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Agent 会收到失败步骤和原因，修复后由你验收并重试
                Complete；不会自动重做已完成的合并或关闭。
              </p>
              <Button
                disabled={sending || sent || progress.status === 'running'}
                onClick={() => void send()}
              >
                {sending ? '正在发送…' : sent ? '已发送修复请求' : '请求 Agent 修复'}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
