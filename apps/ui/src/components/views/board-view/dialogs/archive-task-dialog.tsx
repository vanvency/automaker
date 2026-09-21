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
}: {
  projectPath: string;
  featureIds: string[];
  features: Feature[];
  onClose: () => void;
  onArchived?: () => void;
}) {
  const [reason, setReason] = useState<TaskArchiveReason | ''>('');
  const [description, setDescription] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const targets = features.filter(
    (f) => !featureIds.includes(f.id) && !f.archive && !f.supersededBy && !f.consolidationPlanId
  );
  const submit = async () => {
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
            Archive {featureIds.length === 1 ? 'Task' : `${featureIds.length} Tasks`}
          </DialogTitle>
          <DialogDescription>
            Keep task history, conversations, screenshots and code. Archiving does not close Jira or
            merge requests.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-24 overflow-auto text-sm">
          {featureIds.map((id) => (
            <li key={id}>{features.find((f) => f.id === id)?.title || id}</li>
          ))}
        </ul>
        <label className="space-y-1 text-sm">
          Reason type
          <select
            aria-label="Archive reason"
            className="block w-full rounded border bg-background p-2"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as TaskArchiveReason)}
          >
            <option value="">Select a reason</option>
            {Object.entries(TASK_ARCHIVE_REASONS).map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        {reason === 'duplicate' && (
          <label className="space-y-1 text-sm">
            Duplicate of
            <Autocomplete
              value={duplicateOf}
              disabled={busy}
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
        <label className="space-y-1 text-sm">
          Detailed description
          <textarea
            aria-label="Archive description"
            rows={4}
            className="block w-full rounded border bg-background p-2"
            disabled={busy}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              reason === 'duplicate'
                ? 'Explain which requirements overlap and why the selected task covers them.'
                : 'Explain why this task is being archived and any follow-up decisions.'
            }
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !reason ||
              description.trim().length < 5 ||
              (reason === 'duplicate' && !duplicateOf)
            }
            onClick={submit}
          >
            {busy ? 'Archiving…' : 'Archive Task'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
