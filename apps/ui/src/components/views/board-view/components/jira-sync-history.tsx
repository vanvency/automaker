import type { Feature } from '@automaker/types';

export function JiraSyncHistory({ feature }: { feature: Feature }) {
  if (!feature.jiraSyncHistory?.length && !feature.jiraStatus && !feature.jiraDelivery) return null;
  return (
    <details
      className="my-2 rounded border px-2 py-1 text-[11px]"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer text-muted-foreground">
        同步记录{feature.jiraStatus ? ` · Jira: ${feature.jiraStatus}` : ''}
        {feature.jiraPendingDescription ? ' · 需求已更新' : ''}
      </summary>
      {feature.jiraDelivery && (
        <div className="space-y-1 py-2">
          <p>交付父任务：{feature.jiraDelivery.issueKey}</p>
          <p>Jira 子任务：{feature.jiraDelivery.subtaskKeys.join(', ') || '无'}</p>
          <p className="break-all">统一 worktree：{feature.jiraDelivery.worktree}</p>
          {feature.jiraDelivery.requiresDecision && <p>等待 Jira 拆分或人工批准 Automaker 拆分</p>}
          {!!feature.jiraDelivery.conflictingCards?.length && (
            <p>存在独立子卡，需人工核对范围；不会自动重复派发。</p>
          )}
        </div>
      )}
      {feature.jiraPendingDescription && (
        <p className="my-1">
          Jira 需求有变更，当前 Agent 指令保持不变。请通过 Reply 确认如何处理。
        </p>
      )}
      <ul className="max-h-56 space-y-2 overflow-auto py-2">
        {feature.jiraSyncHistory
          ?.slice()
          .reverse()
          .map((entry, index) => (
            <li key={index} className="break-words">
              <span>
                {new Date(entry.at).toLocaleString()} · {entry.actor} · {entry.action}
              </span>
              <p>
                {entry.reason} · {entry.fields.join(', ')}
              </p>
            </li>
          ))}
      </ul>
    </details>
  );
}
