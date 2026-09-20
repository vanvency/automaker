/** Last deployment operation plus the current Kubernetes readiness check. */
export interface WorktreePreview {
  id: string;
  worktreePath: string;
  context: string;
  namespace: string;
  status: 'deploying' | 'ready' | 'unavailable' | 'stopping' | 'stopped' | 'failed';
  url?: string;
  image?: string;
  updatedAt: string;
  error?: string;
}

export interface WorktreePreviewResponse {
  success: boolean;
  configured?: boolean;
  preview?: WorktreePreview | null;
  error?: string;
}
