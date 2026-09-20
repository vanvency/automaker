import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Feature, ConsolidationPlan } from '@automaker/types';
import { MrConflictNotice } from '../components/kanban-card/mr-conflict-notice';

type Plan = {
  fingerprint: string;
  mergeRequests: Array<{ name: string; url: string; state: string }>;
  /** Delivery MRs GitLab reports as conflicting; an agent can fix these */
  conflicts: Array<{ name: string; mrUrl: string; iid: number }>;
  jira?: ConsolidationPlan['jira'];
  blockers: string[];
};

type JiraTransitionField = NonNullable<
  NonNullable<Plan['jira']>['transitions'][number]['fields']
>[number];

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
  /**
   * Jira transitions demand fields the operator rarely wants to touch
   * (`resolution`, `fixVersions`). Fill the obvious default so Complete works
   * as a single click; the values stay visible and editable below.
   */
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
  const selectTransition = (id: string, currentPlan: Plan | null = plan) => {
    setTransitionId(id);
    const fields = currentPlan?.jira?.transitions.find((t) => t.id === id)?.fields ?? [];
    setJiraFields(withDefaults(fields));
  };
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
  }, [projectPath, feature.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const apply = async () => {
    if (!plan || applying) return;
    setApplying(true);
    setError('');
    try {
      const response = await apiFetch('/api/features/complete', 'POST', {
        body: {
          projectPath,
          featureId: feature.id,
          preview: false,
          fingerprint: plan.fingerprint,
          transitionId,
          jiraFields,
        },
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Completion failed');
      onCompleted();
      onClose();
    } catch (error) {
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
          <DialogTitle>Complete · {feature.jiraKey || feature.title}</DialogTitle>
          <DialogDescription>
            按顺序合并 MR，全部成功后关闭 Jira 并完成任务。遇到冲突或失败会保留在
            Done，可处理后重试。
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取 MR 和 Jira…
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
                </li>
              ))}
            </ol>
            {plan.jira && (
              <div className="space-y-2 text-sm">
                <p>
                  {plan.jira.key} · {plan.jira.status}
                </p>
                {!plan.jira.done && plan.jira.transitions.length > 0 && (
                  <select
                    aria-label="Jira completion status"
                    className="w-full rounded border bg-background p-2"
                    value={transitionId}
                    disabled={applying}
                    onChange={(e) => selectTransition(e.target.value)}
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
            {/* A conflict is not a dead end: the owning task's agent can merge the
                target branch and push the resolution itself. */}
            {(plan.conflicts ?? []).length > 0 && (
              <MrConflictNotice
                projectPath={projectPath}
                featureId={feature.id}
                onDispatched={onClose}
              />
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
          <Button
            disabled={
              loading ||
              applying ||
              !plan ||
              !!plan.blockers.length ||
              (plan.conflicts ?? []).length > 0 ||
              missingFields ||
              (!!plan.jira && !plan.jira.done && !transitionId)
            }
            onClick={() => void apply()}
          >
            {applying ? '正在完成…' : '确认 Complete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
