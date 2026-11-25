/** Last deployment operation plus the current Kubernetes readiness check. */
export interface WorktreePreview {
  id: string;
  worktreePath: string;
  context: string;
  namespace: string;
  status: 'deploying' | 'ready' | 'unavailable' | 'stopping' | 'stopped' | 'failed';
  url?: string;
  image?: string;
  /** The URL includes this worktree's managed devbridge backend session. */
  devbridge?: boolean;
  updatedAt: string;
  /** Start of the latest deployment attempt; stop operations do not change it. */
  deploymentStartedAt?: string;
  /** Time the latest deployment passed its readiness checks. */
  deployedAt?: string;
  error?: string;
  devbridgeConfig?: {
    capturedAt: string;
    configFile: string;
    sourceRoot: string;
    namespace: string;
    gateway: string;
    listen: string;
    stripPrefix: string;
    autoReattach: boolean;
    maxAttempts: number;
    components: Array<{
      name: string;
      configFile?: string;
      dir: string;
      target: string;
      localPort: number;
      remotePort: number;
      routes: string[];
      healthPath: string;
      buildTool: string;
      environmentKeys: string[];
      changeStatus: 'changed' | 'unchanged' | 'unknown';
      changedFiles: number;
      baseRef: string;
    }>;
  };
  devbridgeConfigError?: string;
  /** Bounded, credential-free operation timeline retained after completion. */
  logs?: Array<{
    at: string;
    step: string;
    status: 'running' | 'succeeded' | 'failed';
    message: string;
    /** Arguments are redacted before persisting. */
    command?: string;
    /** Bounded and redacted subprocess output, not a raw terminal transcript. */
    output?: string;
    exitCode?: number | null;
  }>;
}

export interface WorktreePreviewResponse {
  success: boolean;
  configured?: boolean;
  preview?: WorktreePreview | null;
  error?: string;
}
