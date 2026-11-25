import { toast } from 'sonner';
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Feature, ConsolidationPlan } from '@automaker/types';

type Plan = {
  fingerprint: string;
  approved: boolean;
  mergeRequests: Array<{
    name: string;
    url: string;
    state: string;
    draft: boolean;
    pipelineStatus?: string;
    feedback: Array<{ id: number; body: string; author: string; updatedAt: string; url: string }>;
  }>;
  /** Delivery MRs GitLab reports as conflicting; an agent can fix these */
  conflicts: Array<{ name: string; mrUrl: string; iid: number }>;
  jira?: ConsolidationPlan['jira'];
  blockers: string[];
};

type JiraTransitionField = NonNullable<
  NonNullable<Plan['jira']>['transitions'][number]['fields']
>[number];

const withDefaults = (fields: JiraTransitionField[]) =>
  Object.fromEntries(
    fields.map((field) => {
      const planned = Array.isArray(field.value) ? field.value : [];
      if (planned.length > 0 || field.multiple) return [field.key, planned];
      const allowed = field.allowedValues ?? [];
      const preferred =
        field.key === 'resolution'
          ? (allowed.find((option) => /^fixed$/i.test(option.name)) ?? allowed[0])
          : allowed.length === 1
            ? allowed[0]
            : undefined;
      return [field.key, preferred ? [preferred.id] : []];
    })
  );

export function CompleteTaskDialog({
  feature,
  projectPath,
  onClose,
  onCompleted,
}: {
  feature: Feature;
  projectPath: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [transitionId, setTransitionId] = useState('');
  const [jiraFields, setJiraFields] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const selectTransition = useCallback((id: string, currentPlan: Plan | null) => {
    setTransitionId(id);
    const fields = currentPlan?.jira?.transitions.find((t) => t.id === id)?.fields ?? [];
    setJiraFields(withDefaults(fields));
  }, []);
  const requiredFields = plan?.jira?.transitions.find((t) => t.id === transitionId)?.fields ?? [];
  const missingFields = requiredFields.some(
    (field) => !field.supported || !jiraFields[field.key]?.length
  );
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setPlan(null);
    setError('');
    try {
      const response = await apiFetch('/api/features/complete', 'POST', {
        body: { projectPath, featureId: feature.id, preview: true },
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(data.error || 'Could not load completion preview');
      setPlan(data.result);
      selectTransition(
        data.result.jira?.transitions.length === 1 ? data.result.jira.transitions[0].id : '',
        data.result
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectPath, feature.id, selectTransition]);
  useEffect(() => {
    void load();
  }, [load]);
  const apply = async (action: 'approve' | 'fix' | 'confirm') => {
    if (!plan || applying) return;
    setApplying(true);
    setError('');
    try {
      const pending = apiFetch('/api/features/complete', 'POST', {
        body: {
          projectPath,
          featureId: feature.id,
          preview: false,
          action,
          fingerprint: plan.fingerprint,
          transitionId,
          jiraFields,
        },
      });
      if (action === 'confirm') {
        onClose();
        toast.info('Confirm 已提交：预览释放 → MR 合并 → Jira 关闭');
      }
      const response = await pending;
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Completion failed');
      toast.success(
        action === 'approve'
          ? '已移除 Draft，请点击 Confirm 确认交付'
          : action === 'fix'
            ? '已请求 Agent 修复最新 MR 冲突与 review 反馈'
            : '交付完成，任务已归档'
      );
      onCompleted();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
      onCompleted();
      setError((error as Error).message);
      setPlan(null);
    } finally {
      setApplying(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !applying) onClose();
      }}
    >
      <DialogContent
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>
            {plan?.approved ? 'Confirm' : 'Complete'} · {feature.jiraKey || feature.title}
          </DialogTitle>
          <DialogDescription>
            {plan?.approved
              ? '确认后将修改外部系统：① 释放托管预览资源 → ② squash 合并 MR → ③ 关闭 Jira。全部成功后归档任务；失败留在 Done，可核对后重试。'
              : '检查最新 MR 冲突和 review 反馈。可选择 Fix MR 交给 Agent 修复，或 Approve MR 移除 Draft；此操作不会合并或关闭 Jira。'}
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取最新 MR、review 反馈和交付状态…
          </p>
        )}
        {error && (
          <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {plan && (
          <>
            <ol className="space-y-2 text-sm">
              {plan.mergeRequests.map((mr) => (
                <li key={mr.url}>
                  <a
                    className="text-brand-500 hover:underline"
                    href={mr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {mr.name}
                  </a>{' '}
                  · {mr.state}
                  {mr.draft ? ' · Draft' : ''}
                  {mr.pipelineStatus ? ` · CI: ${mr.pipelineStatus}` : ''}
                  <ul className="mt-1 max-h-48 space-y-2 overflow-auto">
                    {(mr.feedback ?? []).map((note) => (
                      <li key={note.id} className="rounded border p-2">
                        <a
                          href={note.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-500 hover:underline"
                        >
                          {note.author || 'Reviewer'}
                          {note.updatedAt ? ` · ${new Date(note.updatedAt).toLocaleString()}` : ''}
                        </a>
                        <Markdown className="break-words [&_p]:whitespace-pre-wrap">
                          {note.body}
                        </Markdown>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            {plan.jira && (
              <div className="space-y-2 text-sm">
                <p>
                  {plan.jira.key} · {plan.jira.status}
                </p>
                {plan.jira.done && (
                  <p className="text-muted-foreground">
                    Jira 已完成，确认后会释放预览、核对 MR 并归档，不会再次关闭 Jira。
                  </p>
                )}
                {!plan.jira.done && plan.jira.transitions.length > 0 && (
                  <select
                    aria-label="Jira completion status"
                    className="w-full rounded border bg-background p-2"
                    value={transitionId}
                    disabled={applying}
                    onChange={(e) => selectTransition(e.target.value, plan)}
                  >
                    <option value="">选择 Jira 完成状态</option>
                    {plan.jira.transitions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} → {t.target}
                      </option>
                    ))}
                  </select>
                )}
                {!plan.jira.done && plan.jira.transitions.length === 0 && (
                  <p role="status" className="text-muted-foreground">
                    当前状态没有可用的 Jira 完成流转，请在 Jira 检查工作流和流转权限后刷新。
                  </p>
                )}
                {!plan.jira.done && requiredFields.length > 0 && (
                  <details
                    className="rounded border border-border/60 p-2"
                    open={missingFields}
                    data-testid="jira-completion-fields"
                  >
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      已自动填写 Jira 完成字段：
                      {requiredFields
                        .map((field) => {
                          const names = (jiraFields[field.key] ?? []).map(
                            (id) =>
                              field.allowedValues.find((option) => option.id === id)?.name ?? id
                          );
                          const label =
                            field.key === 'resolution'
                              ? 'Resolution'
                              : field.key === 'fixVersions'
                                ? 'Fix Version'
                                : field.name;
                          return `${label}=${names.join('、') || '未选择'}`;
                        })
                        .join(' · ')}
                      （点击可修改）
                    </summary>
                    <div className="mt-2 space-y-2">
                      {requiredFields.map((field) => (
                        <label key={field.key} className="block space-y-1">
                          <span>
                            {field.key === 'resolution'
                              ? '解决结果（Resolution）'
                              : field.key === 'fixVersions'
                                ? '修复版本（Fix Version）'
                                : field.name}{' '}
                            *
                          </span>
                          {field.supported ? (
                            <select
                              aria-label={field.name}
                              multiple={field.multiple}
                              size={
                                field.multiple ? Math.min(5, field.allowedValues.length) : undefined
                              }
                              disabled={applying}
                              className="w-full rounded border bg-background p-2"
                              value={
                                field.multiple
                                  ? (jiraFields[field.key] ?? [])
                                  : (jiraFields[field.key]?.[0] ?? '')
                              }
                              onChange={(event) => {
                                const values = Array.from(event.target.selectedOptions)
                                  .map((option) => option.value)
                                  .filter(Boolean);
                                setJiraFields((previous) => ({
                                  ...previous,
                                  [field.key]: values,
                                }));
                              }}
                            >
                              {!field.multiple && <option value="">请选择{field.name}</option>}
                              {field.allowedValues.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <p className="text-destructive">
                              此字段需在 Jira 中填写，完成后请刷新。
                            </p>
                          )}
                          {field.multiple && field.supported && (
                            <span className="block text-xs text-muted-foreground">
                              已保留当前版本，可按 Ctrl / ⌘ 多选。
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            {(plan.conflicts ?? []).map((conflict) => (
              <p key={conflict.mrUrl} role="alert" className="text-sm text-destructive">
                {conflict.name} !{conflict.iid} 存在冲突，请选择 Fix MR 修复后再 Confirm。
              </p>
            ))}
            {!plan.approved && (
              <p className="text-sm text-muted-foreground">
                Approve MR 表示接受当前 review 反馈并移除 Draft；GitLab
                要求的正式审批与讨论解决仍需满足。
              </p>
            )}
            {plan.blockers.map((text) => (
              <p className="break-words text-sm text-destructive" key={text}>
                {text}
              </p>
            ))}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={loading || applying} onClick={() => void load()}>
            刷新
          </Button>
          {plan &&
            ((plan.conflicts ?? []).length > 0 ||
              plan.mergeRequests.some((mr) => mr.feedback?.length)) && (
              <Button
                variant="outline"
                disabled={loading || applying}
                onClick={() => void apply('fix')}
              >
                Fix MR
              </Button>
            )}
          <Button
            disabled={
              loading ||
              applying ||
              !plan ||
              (plan.approved &&
                (!!plan.blockers.length ||
                  (plan.conflicts ?? []).length > 0 ||
                  missingFields ||
                  (!!plan.jira && !plan.jira.done && !transitionId)))
            }
            onClick={() => void apply(plan?.approved ? 'confirm' : 'approve')}
          >
            {applying ? '正在提交…' : plan?.approved ? '确认执行并归档' : 'Approve MR'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
