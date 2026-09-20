import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DEFAULT_JIRA_SYNC_CONFIG,
  type JiraSyncConfig,
  type JiraSyncStatus,
} from '@automaker/types';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhaseModelSelector } from '../settings-view/model-defaults/phase-model-selector';

async function request<T>(
  action: string,
  projectPath: string,
  config?: JiraSyncConfig
): Promise<T> {
  const response = await apiFetch(`/api/jira-sync/${action}`, 'POST', {
    body: { projectPath, config },
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'Jira operation failed');
  return data.result;
}

export function JiraSyncSection({ project }: { project: { path: string } }) {
  const client = useQueryClient();
  const key = ['jira-sync', project.path];
  const query = useQuery({
    queryKey: key,
    queryFn: () => request<JiraSyncStatus>('status', project.path),
    refetchInterval: 3000,
  });
  const [config, setConfig] = useState<JiraSyncConfig>(DEFAULT_JIRA_SYNC_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [mappingText, setMappingText] = useState('{}');
  const [prefixText, setPrefixText] = useState('{}');
  const [autoLabelsText, setAutoLabelsText] = useState('dodo');
  const [manualLabelsText, setManualLabelsText] = useState('kaka');
  useEffect(() => {
    setDirty(false);
    setConfig(DEFAULT_JIRA_SYNC_CONFIG);
  }, [project.path]);
  useEffect(() => {
    if (!dirty && query.data?.config) {
      setConfig(query.data.config);
      setMappingText(JSON.stringify(query.data.config.reviewerOverrides, null, 2));
      setPrefixText(JSON.stringify(query.data.config.branchPrefixes, null, 2));
      setAutoLabelsText(query.data.config.autoLabels.join(', '));
      setManualLabelsText(query.data.config.manualLabels.join(', '));
    }
  }, [query.data?.config, dirty]);
  const update = <K extends keyof JiraSyncConfig>(field: K, value: JiraSyncConfig[K]) => {
    setDirty(true);
    setConfig((previous) => ({ ...previous, [field]: value }));
  };
  const mutation = useMutation({
    mutationFn: async (action: string) => {
      if (action === 'pause')
        return request('save', project.path, { ...query.data!.config!, enabled: false });
      const draft = {
        ...config,
        reviewerOverrides: JSON.parse(mappingText),
        branchPrefixes: JSON.parse(prefixText),
        autoLabels: autoLabelsText
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        manualLabels: manualLabelsText
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      };
      return request(action, project.path, draft);
    },
    onSuccess: (_data, action) => {
      if (action === 'save' || action === 'migrate' || action === 'pause') setDirty(false);
      void client.invalidateQueries({ queryKey: key });
      toast.success(
        action === 'save'
          ? '配置已保存'
          : action === 'migrate'
            ? '已接管旧同步任务'
            : '操作已开始，可在运行记录查看结果'
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = mutation.isPending || query.data?.running;
  const field = (
    label: string,
    name: 'jiraUrl' | 'jiraProject' | 'jql' | 'targetBranch' | 'gitlabHost'
  ) => (
    <label className="space-y-1 text-sm">
      <span>{label}</span>
      <Input
        aria-label={label}
        value={config[name]}
        onChange={(e) => update(name, e.target.value)}
      />
    </label>
  );
  const toggle = (
    label: string,
    name: 'enabled' | 'autoStart' | 'humanInput' | 'branchIncludeLabel'
  ) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={config[name]}
        onChange={(e) => update(name, e.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <div className="space-y-6" data-testid="jira-sync-settings">
      <div>
        <h2 className="text-xl font-semibold">Jira 同步</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          导入 Jira 需求并按规则派发任务。Jira 字段独立同步，不覆盖 Agent
          执行状态、对话及人工验收结果。
        </p>
      </div>
      {query.error && (
        <p role="alert" className="text-destructive">
          {query.error.message}
        </p>
      )}
      {query.data?.legacyAvailable && !query.data.migrated && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">
            发现此项目的旧 Jira monitor。迁移会备份配置和全部 jobs、保留回写标记，并停用旧 systemd
            timer。
          </p>
          <Button disabled={busy} onClick={() => mutation.mutate('migrate')}>
            迁移并接管现有同步
          </Button>
        </div>
      )}
      <fieldset disabled={!!busy} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {field('Jira 地址', 'jiraUrl')}
          {field('Jira 项目 Key', 'jiraProject')}
        </div>
        <p className="text-xs text-muted-foreground">
          认证使用服务端已登录的 Jira CLI；地址必须匹配 CLI 配置。凭据不保存到项目、不返回浏览器。
        </p>
        {field('JQL', 'jql')}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            自动执行标签（逗号分隔）
            <Input
              aria-label="自动执行标签"
              value={autoLabelsText}
              onChange={(e) => {
                setDirty(true);
                setAutoLabelsText(e.target.value);
              }}
            />
          </label>
          <label className="space-y-1 text-sm">
            仅导入标签（逗号分隔）
            <Input
              aria-label="仅导入标签"
              value={manualLabelsText}
              onChange={(e) => {
                setDirty(true);
                setManualLabelsText(e.target.value);
              }}
            />
          </label>
          <label className="space-y-1 text-sm">
            轮询间隔（分钟）
            <Input
              type="number"
              min={1}
              max={1440}
              value={config.intervalMinutes}
              onChange={(e) => update('intervalMinutes', Number(e.target.value))}
            />
          </label>
          <label className="space-y-1 text-sm">
            自动执行容量上限
            <Input
              type="number"
              min={1}
              max={4}
              value={config.maxDispatchPerRun}
              onChange={(e) => update('maxDispatchPerRun', Number(e.target.value))}
            />
          </label>
        </div>
        {toggle('启用定时同步（取消后暂停；不停止已运行的 Agent）', 'enabled')}
        {toggle('允许自动执行标签匹配的新任务（关闭时仅导入）', 'autoStart')}
        <div className="space-y-2">
          <Label>默认 Agent / 模型</Label>
          <PhaseModelSelector
            compact
            value={{ model: config.model, reasoningEffort: config.reasoningEffort }}
            onChange={(entry) => {
              setDirty(true);
              setConfig((previous) => ({
                ...previous,
                model: entry.model,
                reasoningEffort: entry.reasoningEffort ?? previous.reasoningEffort,
              }));
            }}
          />
        </div>
        <div className="rounded border border-brand-500/30 bg-brand-500/5 p-3 text-sm">
          <p className="font-medium">Jira 拆分规则</p>
          <p className="mt-1 text-muted-foreground">
            Jira 子任务优先：父任务是一张 Automaker 卡片、一个交付 worktree 和一组 MR，所有 Jira
            子任务都在同一范围内完成。没有 Jira 子任务的 Epic/Story 不会自动拆分，Agent
            会先请求人工决定。
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            当前固定策略：父任务交付 · 子任务不单独建卡 · 层级 worktree 按 Epic 根任务归并。
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {field('基准及 MR 目标分支', 'targetBranch')}
          {field('GitLab 域名', 'gitlabHost')}
        </div>
        {toggle('新分支名称包含标签（已有分支不重命名）', 'branchIncludeLabel')}
        <p className="text-xs text-muted-foreground">
          MR 固定要求 Draft，人工验收/合并；同步器不自动流转 Jira 状态。
        </p>
        <details className="rounded border p-3">
          <summary className="cursor-pointer text-sm">高级映射配置</summary>
          <label className="mt-3 block text-sm">
            分支前缀映射 JSON
            <textarea
              className="mt-1 w-full rounded border bg-background p-2 font-mono text-xs"
              rows={4}
              value={prefixText}
              onChange={(e) => {
                setDirty(true);
                setPrefixText(e.target.value);
              }}
            />
          </label>
          <label className="mt-3 block text-sm">
            Jira 账号 → GitLab reviewer 映射 JSON
            <textarea
              className="mt-1 w-full rounded border bg-background p-2 font-mono text-xs"
              rows={4}
              value={mappingText}
              onChange={(e) => {
                setDirty(true);
                setMappingText(e.target.value);
              }}
            />
          </label>
        </details>
        <details className="rounded border border-dashed p-3">
          <summary className="cursor-pointer text-sm">高级层级导入（不影响正常 Jira 同步）</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            仅供显式执行 <code>jira-monitor.py --plan-jira-tree/--import-jira-tree</code> 时使用。
            CLI 需附加 <code>--project-settings 项目/.automaker/settings.json</code>{' '}
            才读取这些选项。 日常同步始终遵循上面的 Jira 子任务规则，不创建或搬迁已有分支。
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              层级导入执行单元
              <select
                className="block w-full rounded border bg-background p-2"
                value={config.hierarchyImport?.executionUnit ?? 'story'}
                onChange={(e) => {
                  setDirty(true);
                  setConfig((previous) => ({
                    ...previous,
                    hierarchyImport: {
                      executionUnit: e.target.value as 'story' | 'task',
                      worktreeScope: previous.hierarchyImport?.worktreeScope ?? 'epic',
                    },
                  }));
                }}
              >
                <option value="story">Story 卡片（推荐）</option>
                <option value="task">Task 子任务卡片（兼容）</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              层级导入 worktree
              <select
                className="block w-full rounded border bg-background p-2"
                value={config.hierarchyImport?.worktreeScope ?? 'epic'}
                onChange={(e) => {
                  setDirty(true);
                  setConfig((previous) => ({
                    ...previous,
                    hierarchyImport: {
                      executionUnit: previous.hierarchyImport?.executionUnit ?? 'story',
                      worktreeScope: e.target.value as 'story' | 'epic',
                    },
                  }));
                }}
              >
                <option value="epic">Epic 根共享（推荐）</option>
                <option value="story">Story 独立</option>
              </select>
            </label>
          </div>
        </details>
        <label className="block space-y-1 text-sm">
          Jira 评论回写
          <select
            className="block w-full rounded border bg-background p-2"
            value={config.writeback}
            onChange={(e) => update('writeback', e.target.value as JiraSyncConfig['writeback'])}
          >
            <option value="off">关闭</option>
            <option value="completion">交付后评论</option>
            <option value="milestones">里程碑评论</option>
          </select>
        </label>
        {toggle('启用 Jira 人工问答（发布问题、接收评论并续跑）', 'humanInput')}
        <p className="text-xs text-muted-foreground">
          回写只接收当前执行 runId 对应的回执；迁移保留历史标记，旧结果不重新发布。
        </p>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => mutation.mutate('save')}>
          保存配置
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => mutation.mutate('test')}>
          测试连接
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => mutation.mutate('preview')}>
          预览匹配与变更
        </Button>
        <Button
          variant="outline"
          disabled={busy || dirty || !query.data?.config}
          onClick={() => mutation.mutate('sync')}
        >
          立即同步
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            !query.data?.config?.enabled ||
            (query.data.legacyAvailable && !query.data.migrated)
          }
          onClick={() => mutation.mutate('pause')}
        >
          暂停同步
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {query.data?.running ? '正在执行…' : '空闲'} · 已记录 {query.data?.jobCount ?? 0} 个 Jira
        jobs
        {query.data?.nextRunAt && ` · 下次同步 ${new Date(query.data.nextRunAt).toLocaleString()}`}
        {dirty && ' · 有未保存改动；测试/预览使用草稿，同步使用已保存配置'}
      </p>
      <div className="space-y-2">
        <h3 className="font-medium">运行记录</h3>
        {(query.data?.runs ?? []).map((run) => (
          <details className="rounded border p-3" key={run.id} open={run.status === 'running'}>
            <summary className="cursor-pointer text-sm">
              {new Date(run.startedAt).toLocaleString()} · {run.mode} · {run.status} · {run.trigger}
            </summary>
            <p className="mt-2 break-words text-xs">{run.error || run.message}</p>
            <p className="text-[10px] text-muted-foreground">Run ID: {run.id}</p>
            {!!run.changes?.length && (
              <table className="mt-2 w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>动作</th>
                    <th>原因 / 字段</th>
                  </tr>
                </thead>
                <tbody>
                  {run.changes.map((change, index) => (
                    <tr key={index} className="border-t">
                      <td className="py-2">{change.issueKey}</td>
                      <td>{change.action}</td>
                      <td>
                        {change.reason}
                        {change.delivery && (
                          <div className="mt-1 space-y-1">
                            <p>
                              交付父任务：{change.delivery.issueKey} · 包含子任务：
                              {change.delivery.subtaskKeys.join(', ') || '无'}
                            </p>
                            <p className="break-all">
                              worktree：{change.delivery.worktree} · 分支：{change.delivery.branch}
                            </p>
                            <p>
                              {change.delivery.requiresDecision
                                ? '等待 Jira 拆分或人工批准 Automaker 拆分'
                                : '父任务统一交付'}
                              {change.delivery.conflictingCards?.length
                                ? ' · 已有独立子卡，需人工核对范围'
                                : ''}
                            </p>
                            <p>
                              本轮自动执行：
                              {run.changes?.some(
                                (item) =>
                                  item.featureId === change.featureId && item.action === 'dispatch'
                              )
                                ? '是'
                                : '否'}
                            </p>
                          </div>
                        )}
                        {change.fields?.length ? ` · ${change.fields.join(', ')}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        ))}
      </div>
      {!!query.data?.jobs?.length && (
        <details className="rounded border p-3">
          <summary className="cursor-pointer text-sm">
            任务映射与派发状态（{query.data.jobCount}）
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            已认领但结果不确定的任务不会自动重试；请到任务卡查看 Conversation 并决定是否继续。
          </p>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Jira</th>
                  <th>任务卡</th>
                  <th>同步状态</th>
                </tr>
              </thead>
              <tbody>
                {query.data.jobs.map((job) => (
                  <tr key={job.issueKey} className="border-t">
                    <td className="py-2">{job.issueKey}</td>
                    <td>{job.featureId}</td>
                    <td>
                      {job.status}
                      {job.claimed ? ' · 已认领' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
