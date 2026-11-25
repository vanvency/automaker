import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
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

interface ResetPreview {
  featureId: string;
  issueKey: string;
  title: string;
  oldBranch: string;
  oldWorktree: string;
  newBranch: string;
  hasLocalChanges: boolean;
  snapshot: string;
}

export function ResetWorkAction({
  projectPath,
  featureId,
  disabled,
  icon = false,
  onReset,
}: {
  projectPath: string;
  featureId: string;
  disabled?: boolean;
  icon?: boolean;
  onReset?: () => void | Promise<void>;
}) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const request = async (action: 'reset-preview' | 'reset-work', snapshot?: string) => {
    const response = await apiFetch(`/api/jira-sync/${action}`, 'POST', {
      body: { projectPath, featureId, snapshot },
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Work reset failed');
    return result.result;
  };
  const run = async (action: 'reset-preview' | 'reset-work') => {
    setBusy(true);
    try {
      const result = await request(action, action === 'reset-work' ? preview?.snapshot : undefined);
      if (action === 'reset-preview') {
        setPreview(result.reset);
      } else {
        setPreview(null);
        await Promise.all([
          client.invalidateQueries({ queryKey: ['jira-sync', projectPath] }),
          client.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) }),
        ]);
        await onReset?.();
        toast.success(`已创建新 Work：${result.reset.featureId}`);
      }
    } catch (error) {
      toast.error((error as Error).message);
      if (action === 'reset-work') setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant={icon ? 'ghost' : 'outline'}
        size={icon ? 'icon-sm' : 'sm'}
        className={icon ? 'h-7 w-7' : undefined}
        title="重置 Work"
        aria-label="重置 Work"
        disabled={disabled || busy}
        onClick={(event) => {
          event.stopPropagation();
          void run('reset-preview');
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {icon ? <RotateCcw className="h-3.5 w-3.5" /> : '重置 Work'}
      </Button>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认重置 Work · {preview?.issueKey}</DialogTitle>
            <DialogDescription>
              将重新读取 Jira 并创建新任务、新分支与 Worktree。旧任务会归档，旧 Agent
              对话不会继续使用；旧 Worktree 将被强制移除。不会修改 Jira、远端分支或 MR。
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-2 text-sm break-all">
              <p>最新 Jira：{preview.title}</p>
              <p>
                旧分支：{preview.oldBranch} · 旧目录：{preview.oldWorktree}
              </p>
              <p>新分支：{preview.newBranch}</p>
              {preview.hasLocalChanges && (
                <p className="text-destructive font-medium">
                  旧 Worktree 有未提交修改，确认后会被丢弃。
                </p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void run('reset-work')}>
              {busy ? '正在重置…' : '确认丢弃旧 Work 并重建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
