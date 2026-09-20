export interface JiraSyncConfig {
  enabled: boolean;
  jiraUrl: string;
  jiraProject: string;
  jql: string;
  intervalMinutes: number;
  autoLabels: string[];
  manualLabels: string[];
  autoStart: boolean;
  maxDispatchPerRun: number;
  model: string;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  executionUnit: 'story' | 'task';
  worktreeScope: 'story' | 'epic';
  targetBranch: string;
  branchIncludeLabel: boolean;
  branchPrefixes: Record<string, string>;
  gitlabHost: string;
  reviewerOverrides: Record<string, string>;
  writeback: 'off' | 'completion' | 'milestones';
  humanInput: boolean;
  hierarchyImport?: {
    executionUnit: 'story' | 'task';
    worktreeScope: 'story' | 'epic';
  };
}

export interface JiraSyncChange {
  issueKey: string;
  featureId?: string;
  action: 'create' | 'update' | 'skip' | 'dispatch' | 'blocked';
  reason: string;
  fields?: string[];
  delivery?: JiraDeliveryScope;
}

export interface JiraDeliveryScope {
  issueKey: string;
  subtaskKeys: string[];
  branch: string;
  worktree: string;
  requiresDecision: boolean;
  rule: 'parent-with-jira-subtasks';
  conflictingCards?: string[];
}

export interface JiraSyncRun {
  id: string;
  mode: 'test' | 'preview' | 'sync' | 'migration' | 'config';
  status: 'running' | 'success' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  trigger: 'manual' | 'schedule' | 'migration';
  changes?: JiraSyncChange[];
  error?: string;
  message?: string;
}

export interface JiraSyncStatus {
  config: JiraSyncConfig | null;
  runs: JiraSyncRun[];
  running: boolean;
  nextRunAt?: string;
  legacyAvailable: boolean;
  migrated: boolean;
  jobCount: number;
  jobs?: Array<{
    issueKey: string;
    featureId?: string;
    status: string;
    claimed: boolean;
  }>;
}

export const DEFAULT_JIRA_SYNC_CONFIG: JiraSyncConfig = {
  enabled: false,
  jiraUrl: '',
  jiraProject: '',
  jql: '',
  intervalMinutes: 5,
  autoLabels: ['dodo'],
  manualLabels: ['kaka'],
  autoStart: false,
  maxDispatchPerRun: 1,
  model: 'pi:litellm/worker',
  reasoningEffort: 'medium',
  executionUnit: 'story',
  worktreeScope: 'epic',
  targetBranch: 'dev',
  branchIncludeLabel: true,
  branchPrefixes: {},
  gitlabHost: '',
  reviewerOverrides: {},
  writeback: 'off',
  humanInput: false,
  hierarchyImport: { executionUnit: 'story', worktreeScope: 'epic' },
};
