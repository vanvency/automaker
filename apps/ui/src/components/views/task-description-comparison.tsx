import { useState } from 'react';
import type { SimilarTask } from '@automaker/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function TaskDescriptionComparison({
  tasks,
  selection,
  onChange,
  onClose,
  onKeep,
}: {
  tasks: SimilarTask[];
  selection: [string, string] | null;
  onChange: (selection: [string, string]) => void;
  onClose: () => void;
  onKeep: (keep: string, retire: string) => void;
}) {
  const [content, setContent] = useState<'description' | 'scope'>('description');
  const chosen = selection?.map((id) => tasks.find((task) => task.id === id)) ?? [];
  const valid = !!chosen[0] && !!chosen[1] && chosen[0].id !== chosen[1].id;
  return (
    <Dialog
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Compare Task Descriptions</DialogTitle>
          <DialogDescription>
            Choose any two parent tasks and read their descriptions side by side. Comparing does not
            change either task.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            Content
            <select
              aria-label="Comparison content"
              className="rounded border bg-background p-2"
              value={content}
              onChange={(e) => setContent(e.target.value as typeof content)}
            >
              <option value="description">Full Task Description</option>
              <option value="scope">Extracted Requirements</option>
            </select>
          </label>
          <Button
            variant="outline"
            disabled={!selection}
            onClick={() => selection && onChange([selection[1], selection[0]])}
          >
            Swap Sides
          </Button>
        </div>
        <div className="grid min-h-0 gap-4 overflow-auto md:grid-cols-2">
          {([0, 1] as const).map((index) => {
            const task = chosen[index];
            return (
              <section
                key={index}
                className="flex min-h-0 min-w-0 flex-col rounded border"
                aria-label={index === 0 ? 'Left task description' : 'Right task description'}
              >
                <div className="space-y-2 border-b p-3">
                  <label className="block text-sm">
                    {index === 0 ? 'Left Task' : 'Right Task'}
                    <select
                      aria-label={index === 0 ? 'Left Task' : 'Right Task'}
                      value={selection?.[index] ?? ''}
                      className="mt-1 block w-full rounded border bg-background p-2"
                      onChange={(e) => {
                        const next: [string, string] = [...(selection ?? ['', ''])];
                        next[index] = e.target.value;
                        onChange(next);
                      }}
                    >
                      <option value="">Select a parent task</option>
                      {tasks.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {task && (
                    <p className="text-xs text-muted-foreground">
                      {task.jiraKey || task.id} · {task.status || 'Unknown status'}
                    </p>
                  )}
                </div>
                <div className="min-h-40 overflow-y-auto p-3 md:h-[48vh]" tabIndex={0}>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {task
                      ? (content === 'description'
                          ? (task.description ?? task.scope)
                          : task.scope) || 'No description provided.'
                      : 'Select a task to view its description.'}
                  </p>
                </div>
                <div className="border-t p-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!valid}
                    onClick={() => {
                      if (valid) onKeep(chosen[index]!.id, chosen[index === 0 ? 1 : 0]!.id);
                    }}
                  >
                    Keep {task?.jiraKey || (index === 0 ? 'Left Task' : 'Right Task')}
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
        {selection?.[0] && selection[0] === selection[1] && (
          <p className="text-sm text-muted-foreground">
            Select two different tasks to choose a coverage direction.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
