export const TASK_ARCHIVE_REASONS = {
  duplicate: 'Duplicate task',
  deferred: 'Not proceeding for now',
  already_taken: 'Already taken (completed by someone else)',
  done: 'Done',
  obsolete: 'Requirement no longer valid',
  conflict: 'Conflicting requirements',
  completed: 'Delivery completed',
} as const;
export type TaskArchiveReason = keyof typeof TASK_ARCHIVE_REASONS;
export interface TaskArchiveRequest {
  reason: TaskArchiveReason;
  description: string;
  duplicateOf?: string;
}
export interface TaskArchiveRecord extends TaskArchiveRequest {
  archivedAt: string;
  previousStatus: string;
  duplicateTitle?: string;
  duplicateJiraKey?: string;
  restoredAt?: string;
}
