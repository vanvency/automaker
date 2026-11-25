import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PendingAttentionMove } from '../hooks/use-board-drag-drop';
import { COLUMNS } from '../constants';

export function AttentionMoveDialog({
  move,
  busy,
  onCancel,
  onConfirm,
}: {
  move: PendingAttentionMove | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={!!move} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认移动 Need Attention 任务</DialogTitle>
          <DialogDescription>
            此任务仍有失败、冲突或交付阻塞。请确认已自行检查代码与
            MR，并愿意承担状态与实际交付不一致的风险。
          </DialogDescription>
        </DialogHeader>
        {move && (
          <div className="space-y-3 text-sm">
            <p className="font-medium break-words">
              {move.feature.jiraKey || move.feature.id} ·{' '}
              {move.feature.title || move.feature.description}
            </p>
            <p>目标状态：{COLUMNS.find((column) => column.id === move.targetStatus)?.title}</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
              {move.feature.error ||
                move.feature.executionNotice?.message ||
                '任务执行未正常完成。'}
            </p>
            <p>
              {move.targetStatus === 'in_progress'
                ? '确认后会重新启动 Agent 执行任务。'
                : move.targetStatus === 'backlog'
                  ? '确认后将清除当前提醒并移回 Backlog，不会自动启动 Agent。'
                  : '确认后将跳过本次交付检查并清除当前提醒，记录人工风险确认。不会合并 MR、修改 Jira 或执行部署。'}
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? '正在移动…' : '接受风险并移动'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
