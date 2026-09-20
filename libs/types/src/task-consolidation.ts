/** Required Jira transition fields exposed by the human Complete workflow. */
export interface JiraCompletionField {
  key: string;
  name: string;
  multiple: boolean;
  supported: boolean;
  allowedValues: Array<{ id: string; name: string }>;
  value: string[];
}

export interface SimilarTask {
  id: string;
  title: string;
  jiraKey?: string;
  status?: string;
  scope: string;
  /** Complete task-card description for manual comparison, not the similarity excerpt. */
  description?: string;
  summary?: string;
}

export interface SimilarTaskPair {
  left: SimilarTask;
  right: SimilarTask;
  score: number;
  reasons: string[];
  sharedTerms: string[];
  /** Lexical scope overlap, not proof of implementation coverage. */
  leftOverlap: number;
  rightOverlap: number;
}

export interface ConsolidationPlan {
  id: string;
  projectPath: string;
  keep: SimilarTask;
  retire: SimilarTask;
  reason: string;
  createdAt: string;
  expiresAt: string;
  status: 'planned' | 'running' | 'partial' | 'complete' | 'cancelled';
  fingerprint: string;
  blockers: string[];
  warnings: string[];
  mergeRequests: Array<{
    url: string;
    state: string;
    sourceBranch?: string;
    sha?: string;
    action: 'close' | 'preserve';
    reason: string;
  }>;
  jira?: {
    key: string;
    url: string;
    status: string;
    updated: string;
    done: boolean;
    transitions: Array<{
      id: string;
      name: string;
      target: string;
      fields?: JiraCompletionField[];
    }>;
    error?: string;
  };
  selection?: { mrUrls: string[]; transitionId?: string; closeJira: boolean };
  steps: Array<{ target: string; status: 'running' | 'done' | 'failed'; message?: string }>;
}
