import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Feature } from '@automaker/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** A persisted task notice is not necessarily the agent's latest answer. */
export function TaskNotice({ feature }: { feature: Feature }) {
  const [open, setOpen] = useState(false);
  const notice = feature.executionNotice;
  const message = feature.error?.trim() || notice?.message;
  if (!message) return null;
  // A legacy writer may update error without updating its metadata.
  const matches = notice?.message.trim() === message;
  const source = matches
    ? { execution: '执行器错误', delivery: '交付待确认事项', recovery: '状态恢复说明' }[
        notice.source
      ]
    : '历史任务提示（来源时间未记录）';
  return (
    <div
      className="mb-2"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="w-full rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error-bg)] px-2 py-1.5 text-left text-[var(--status-error)]"
        data-testid={`card-message-${feature.id}`}
        onClick={() => setOpen(true)}
        aria-label="查看任务提示详情"
      >
        <span className="flex items-start gap-1.5">
          <AlertCircle className="mt-[1px] h-3 w-3 shrink-0" />
          <span className="line-clamp-3 break-words text-[10px] leading-relaxed">{message}</span>
        </span>
        <span className="mt-1 block text-[10px] underline">查看详情</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>任务提示详情</DialogTitle>
            <DialogDescription>
              {source}
              {matches ? ` · ${new Date(notice.occurredAt).toLocaleString()}` : ''}
            </DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap break-words text-sm">{message}</p>
          <p className="text-xs text-muted-foreground">
            此处是任务状态说明；Agent 对话记录请查看 Conversation。可通过 Reply 补充信息或继续处理。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
