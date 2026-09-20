'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Archive } from 'lucide-react';

interface ArchiveAllVerifiedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verifiedCount: number;
  onConfirm: () => void;
}

export function ArchiveAllVerifiedDialog({
  open,
  onOpenChange,
  verifiedCount,
  onConfirm,
}: ArchiveAllVerifiedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="archive-all-verified-dialog">
        <DialogHeader>
          <DialogTitle>Archive Verified Tasks</DialogTitle>
          <DialogDescription>
            Continue to choose an archive reason and provide details for these tasks.
            {verifiedCount > 0 && (
              <span className="block mt-2 text-yellow-500">{verifiedCount} task(s) selected.</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="default" onClick={onConfirm} data-testid="confirm-archive-all-verified">
            <Archive className="w-4 h-4 mr-2" />
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
