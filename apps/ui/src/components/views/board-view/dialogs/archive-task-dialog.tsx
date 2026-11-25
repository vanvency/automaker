import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TASK_ARCHIVE_REASONS, type Feature, type TaskArchiveReason } from '@automaker/types';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/store/app-store';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Autocomplete } from '@/components/ui/autocomplete';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export function ArchiveTaskDialog({
  projectPath,
  featureIds,
  features,
  onClose,
  onArchived,
  workScope = false,
  loading = false,
}: {
  projectPath: string;
  featureIds: string[];
  features: Pick<
    Feature,
    'id' | 'title' | 'jiraKey' | 'archive' | 'supersededBy' | 'consolidationPlanId'
  >[];
  onClose: () => void;
  onArchived?: () => void;
  workScope?: boolean;
  loading?: boolean;
}) {
  const [reason, setReason] = useState<TaskArchiveReason | ''>(workScope ? 'already_taken' : '');
  const [description, setDescription] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const targets = features.filter(
    (f) => !featureIds.includes(f.id) && !f.archive && !f.supersededBy && !f.consolidationPlanId
  );
  const submit = async () => {
    if (loading || busy) return;
    setBusy(true);
    try {
      const response = await apiFetch('/api/features/archive', 'POST', {
        body: {
          projectPath,
          featureIds,
          archive: {
            reason,
            description,
            duplicateOf: reason === 'duplicate' ? duplicateOf : undefined,
          },
        },
      });
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.error || 'Could not archive tasks');
      for (const feature of result.features)
        useAppStore.getState().updateFeature(feature.id, feature);
      await client.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
      toast.success(`${result.archivedCount} task(s) archived`);
      onArchived?.();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {workScope
              ? 'Archive Work'
              : `Archive ${featureIds.length === 1 ? 'Task' : `${featureIds.length} Tasks`}`}
          </DialogTitle>
          <DialogDescription>
            Keep task history, conversations, screenshots and code. Archiving only updates
            Automaker; it does not change Jira fields, comments or status, or modify merge requests.
            {workScope && ' This archives all active tasks attached to this worktree.'}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-28 shrink-0 overflow-auto rounded-lg border border-border/50 bg-muted/30 p-3 text-sm space-y-1 break-words">
          {featureIds.map((id) => (
            <li key={id}>{features.find((f) => f.id === id)?.title || id}</li>
          ))}
        </ul>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading tasks…
          </p>
        )}
        <label className="block space-y-2 text-sm font-medium">
          Reason type
          <select
            aria-label="Archive reason"
            className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as TaskArchiveReason)}
          >
            <option value="">Select a reason</option>
            {Object.entries(TASK_ARCHIVE_REASONS)
              .filter(([key]) => key !== 'completed')
              .map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
          </select>
        </label>
        {reason === 'duplicate' && (
          <label className="block space-y-2 text-sm font-medium">
            Duplicate of
            <Autocomplete
              value={duplicateOf}
              disabled={busy || loading}
              onChange={setDuplicateOf}
              placeholder="Select the existing task"
              searchPlaceholder="Search by title, Jira key or task ID..."
              emptyMessage="No matching tasks."
              options={targets.map((f) => ({
                value: f.id,
                label: [f.jiraKey, f.title || f.id].filter(Boolean).join(' · '),
              }))}
            />
          </label>
        )}
        <label className="block space-y-2 text-sm font-medium">
          Detailed description (optional)
          <textarea
            aria-label="Archive description"
            rows={4}
            className="block min-h-28 w-full resize-y rounded-md border border-input bg-background p-3 text-sm font-normal leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              reason === 'duplicate'
                ? 'Explain which requirements overlap and why the selected task covers them.'
                : reason === 'already_taken'
                  ? 'Record who completed the work and any related delivery reference.'
                  : 'Explain why this task is being archived and any follow-up decisions.'
            }
          />
        </label>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || loading || !reason || (reason === 'duplicate' && !duplicateOf)}
            onClick={submit}
          >
            {busy ? 'Archiving…' : workScope ? 'Archive Work' : 'Archive Task'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
