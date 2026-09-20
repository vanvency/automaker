import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Images, Loader2 } from 'lucide-react';
import type { AcceptanceEvidence as Evidence } from '@automaker/types';
import { getAuthenticatedImageUrl } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const STATUS_LABELS = { passed: '验证通过 · 待人工验收', failed: '验证失败', blocked: '验证受阻' };
const CHECK_LABELS = { passed: '通过', failed: '失败', skipped: '未验证' };
const safeLink = (url?: string) => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** Durable outputs are separate from the task's input/reference attachments. */
export function AcceptanceEvidence({
  evidence,
  projectPath,
}: {
  evidence?: Evidence;
  projectPath: string;
}) {
  const [open, setOpen] = useState(false);
  if (!evidence) return null;
  const previewUrl = safeLink(evidence.previewUrl);
  const renderImage = (shot: Evidence['screenshots'][number], large = false) => (
    <figure key={shot.path + shot.kind} className="min-w-0 space-y-1">
      <img
        src={getAuthenticatedImageUrl(shot.path, projectPath, evidence.importedAt)}
        alt={`${shot.kind === 'prototype' ? '原型图' : '真实截图'}：${shot.title}`}
        loading="lazy"
        className={
          large
            ? 'max-h-[65vh] w-full rounded border object-contain'
            : 'h-24 w-full rounded border object-contain'
        }
      />
      <figcaption className="break-words text-xs text-muted-foreground">
        {shot.kind === 'prototype' ? '原型图' : '真实截图'} · {shot.title}
        {large && (
          <div className="mt-1 space-x-2">
            <time dateTime={shot.capturedAt}>{new Date(shot.capturedAt).toLocaleString()}</time>
            {safeLink(shot.sourceUrl) && (
              <a
                href={shot.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-500 hover:underline"
              >
                页面来源
              </a>
            )}
            <a
              href={getAuthenticatedImageUrl(shot.path, projectPath, evidence.importedAt)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-500 hover:underline"
            >
              查看原图
            </a>
          </div>
        )}
      </figcaption>
    </figure>
  );
  const coverImages = ['prototype', 'actual'].flatMap((kind) => {
    const shot = evidence.screenshots.find((item) => item.kind === kind);
    return shot ? [shot] : [];
  });
  return (
    <section
      className="my-2 space-y-2 rounded-md border border-border/60 bg-muted/20 p-2"
      data-testid="acceptance-evidence"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
        <span className="font-medium">验收结果</span>
        <span
          className={
            evidence.status === 'passed'
              ? 'text-green-600 dark:text-green-400'
              : 'text-amber-600 dark:text-amber-400'
          }
        >
          {STATUS_LABELS[evidence.status]}
        </span>
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {evidence.summary}
      </p>
      {coverImages.length > 0 && (
        <button
          type="button"
          className="grid w-full grid-cols-2 gap-2 text-left"
          onClick={() => setOpen(true)}
          aria-label="查看原型图与真实截图"
        >
          {coverImages.map((shot) => renderImage(shot))}
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen(true)}>
          <Images className="mr-1 h-3 w-3" />
          查看验收材料
        </Button>
        {previewUrl && (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            打开验证环境
          </a>
        )}
      </div>
      <AcceptanceEvidenceDialog
        evidence={evidence}
        projectPath={projectPath}
        open={open}
        onOpenChange={setOpen}
      />
    </section>
  );
}

/**
 * The acceptance result viewer.
 *
 * Extracted so the card's Verify button (approval lane) opens the same view as
 * the inline card, without either entry owning the other.
 */
export function AcceptanceEvidenceDialog({
  evidence,
  projectPath,
  open,
  onOpenChange,
  onConfirm,
}: {
  evidence?: Evidence;
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: () => void | boolean | Promise<void | boolean>;
}) {
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setImageIndex(null);
      setConfirmError(null);
    }
  }, [open]);
  const screenshots = evidence?.screenshots ?? [];
  const activeImage = imageIndex === null ? undefined : screenshots[imageIndex];
  const moveImage = (direction: number) => {
    setImageIndex((index) =>
      index === null || !screenshots.length
        ? null
        : (index + direction + screenshots.length) % screenshots.length
    );
  };
  const imageUrl = (shot: Evidence['screenshots'][number]) =>
    getAuthenticatedImageUrl(shot.path, projectPath, evidence?.importedAt);
  const imageLabel = (shot: Evidence['screenshots'][number]) =>
    `${shot.kind === 'prototype' ? '原型图' : '真实截图'}：${shot.title}`;
  const dialogPreviewUrl = safeLink(evidence?.previewUrl);
  let dialogPreviewLabel = '打开独立验证环境';
  if (dialogPreviewUrl) {
    try {
      const parsed = new URL(dialogPreviewUrl);
      dialogPreviewLabel = `打开验证环境 · ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
      // safeLink already filters malformed URLs.
    }
  }

  const confirm = async () => {
    if (!onConfirm || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const result = await onConfirm();
      if (result === false) setConfirmError('验收状态保存失败，请重试。');
      else onOpenChange(false);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : '验收状态保存失败，请重试。');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!confirming) onOpenChange(value);
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-6xl"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (activeImage && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            moveImage(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
        onEscapeKeyDown={(event) => {
          if (activeImage) {
            event.preventDefault();
            setImageIndex(null);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {activeImage
              ? imageLabel(activeImage)
              : `验收材料${evidence ? ` · ${STATUS_LABELS[evidence.status]}` : ''}`}
          </DialogTitle>
          <DialogDescription>
            {activeImage
              ? '使用上一张、下一张或键盘左右方向键切换截图。'
              : '查看验收结果并确认 Verify 后，任务进入 Done；点击 Complete 后才执行 MR 合并并关闭 Jira。'}
          </DialogDescription>
        </DialogHeader>
        {!activeImage && dialogPreviewUrl && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-500/40 bg-brand-500/10 px-4 py-3"
            data-testid="acceptance-preview-link"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold">验收环境</p>
              <p className="truncate text-xs text-muted-foreground" title={dialogPreviewUrl}>
                {dialogPreviewUrl}
              </p>
            </div>
            <a
              href={dialogPreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              <ExternalLink className="h-4 w-4" />
              {dialogPreviewLabel}
            </a>
          </div>
        )}
        {activeImage ? (
          <div className="space-y-3" data-testid="evidence-image-viewer">
            <img
              src={imageUrl(activeImage)}
              alt={imageLabel(activeImage)}
              className="max-h-[65vh] w-full rounded border object-contain"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" onClick={() => setImageIndex(null)}>
                返回验收结果
              </Button>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  aria-label="上一张"
                  disabled={screenshots.length < 2}
                  onClick={() => moveImage(-1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  上一张
                </Button>
                <span className="text-sm tabular-nums" aria-live="polite">
                  {(imageIndex ?? 0) + 1} / {screenshots.length}
                </span>
                <Button
                  variant="outline"
                  aria-label="下一张"
                  disabled={screenshots.length < 2}
                  onClick={() => moveImage(1)}
                >
                  下一张
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <a
                href={imageUrl(activeImage)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand-500 hover:underline"
              >
                查看原图
              </a>
            </div>
          </div>
        ) : (
          <>
            {evidence ? (
              <>
                <p className="whitespace-pre-wrap break-words text-sm">{evidence.summary}</p>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>验证时间：{new Date(evidence.verifiedAt).toLocaleString()}</span>
                  {evidence.commit && (
                    <span className="break-all">代码版本：{evidence.commit}</span>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {(['prototype', 'actual'] as const).map((kind) => (
                    <div key={kind} className="min-w-0 space-y-3">
                      <h3 className="text-sm font-medium">
                        {kind === 'prototype' ? '原型参考' : '真实环境截图'}
                      </h3>
                      {screenshots.map(
                        (shot, index) =>
                          shot.kind === kind && (
                            <figure key={`${shot.path}-${index}`} className="min-w-0 space-y-1">
                              <button
                                type="button"
                                className="block w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                                onClick={() => setImageIndex(index)}
                                aria-label={`放大${imageLabel(shot)}`}
                              >
                                <img
                                  src={imageUrl(shot)}
                                  alt={imageLabel(shot)}
                                  loading="lazy"
                                  className="max-h-64 w-full rounded border object-contain"
                                />
                              </button>
                              <figcaption className="break-words text-xs text-muted-foreground">
                                {imageLabel(shot)}
                                <div className="mt-1 space-x-2">
                                  <time dateTime={shot.capturedAt}>
                                    {new Date(shot.capturedAt).toLocaleString()}
                                  </time>
                                  {safeLink(shot.sourceUrl) && (
                                    <a
                                      href={shot.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-brand-500 hover:underline"
                                    >
                                      页面来源
                                    </a>
                                  )}
                                </div>
                              </figcaption>
                            </figure>
                          )
                      )}
                      {!screenshots.some((shot) => shot.kind === kind) && (
                        <p className="text-xs text-muted-foreground">尚未提供</p>
                      )}
                    </div>
                  ))}
                </div>
                <ul className="space-y-2">
                  {evidence.checks.map((check, index) => (
                    <li key={index} className="rounded border p-2 text-sm">
                      <span className="font-medium">
                        {CHECK_LABELS[check.status]} · {check.name}
                      </span>
                      {check.details && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {check.details}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                此任务尚未提供验收材料，请结合实际运行结果进行人工验收。
              </p>
            )}
            {onConfirm && (
              <div className="sticky bottom-0 -mb-2 mt-4 flex flex-wrap items-center justify-between gap-3 border-t bg-card py-3">
                <p className="max-w-xl text-xs text-muted-foreground">
                  {!evidence ||
                  evidence.status !== 'passed' ||
                  evidence.checks.some((check) => check.status !== 'passed')
                    ? '验收材料仍有缺失或未通过项。确认表示你已人工验收并接受这些已列明的情况；原始验证结果会保留。'
                    : '确认人工验收后进入 Done，等待 Complete。'}
                </p>
                {confirmError && (
                  <p role="alert" className="text-sm text-destructive">
                    {confirmError}
                  </p>
                )}
                <Button
                  onClick={() => void confirm()}
                  disabled={confirming}
                  data-testid="confirm-verify"
                >
                  {confirming && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {confirming ? '正在保存…' : '确认 Verify · 移入 Done'}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
