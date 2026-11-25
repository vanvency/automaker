import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ArchiveRestore } from 'lucide-react';
import { TaskArchiveDetails } from '../components/task-archive-details';
import { Feature } from '@/store/app-store';
import { extractImplementationSummary } from '@/lib/log-parser';
import { getFirstNonEmptySummary } from '@/lib/summary-selection';

interface CompletedFeaturesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  completedFeatures: Feature[];
  onUnarchive: (feature: Feature) => void;
  branchName: string | null;
}

export function CompletedFeaturesModal({
  open,
  onOpenChange,
  completedFeatures,
  onUnarchive,
  branchName,
}: CompletedFeaturesModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-6xl max-h-[90vh] flex flex-col"
        data-testid="completed-features-modal"
      >
        <DialogHeader>
          <DialogTitle>Archived Tasks</DialogTitle>
          <DialogDescription>
            {completedFeatures.length === 0
              ? 'No archived tasks yet.'
              : `${completedFeatures.length} archived task${
                  completedFeatures.length > 1 ? 's' : ''
                }`}
            {' · '}
            {branchName || 'Primary worktree'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto py-4">
          {completedFeatures.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              <ArchiveRestore className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No archived tasks</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {completedFeatures.map((feature) => {
                const implementationSummary = extractImplementationSummary(feature.summary);
                const displayText = getFirstNonEmptySummary(
                  feature.title,
                  implementationSummary,
                  feature.summary,
                  feature.description,
                  feature.id
                );

                return (
                  <Card
                    key={feature.id}
                    className="flex flex-col"
                    data-testid={`completed-card-${feature.id}`}
                  >
                    <CardHeader className="p-3 pb-2 flex-1">
                      <CardTitle className="text-sm leading-tight line-clamp-3">
                        {displayText ?? feature.id}
                      </CardTitle>
                      <CardDescription className="text-xs mt-1 truncate">
                        {feature.category || 'Uncategorized'}
                      </CardDescription>
                      <p className="text-xs text-muted-foreground break-all">
                        {typeof feature.jiraKey === 'string' ? feature.jiraKey : feature.id} ·{' '}
                        {feature.branchName || 'Primary worktree'}
                      </p>
                    </CardHeader>
                    <div className="px-3">
                      <TaskArchiveDetails feature={feature} expanded />
                    </div>
                    <div className="p-3 pt-0 flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => onUnarchive(feature)}
                        data-testid={`unarchive-${feature.id}`}
                      >
                        <ArchiveRestore className="w-3 h-3 mr-1" />
                        Restore
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
