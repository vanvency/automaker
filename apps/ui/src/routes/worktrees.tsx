import { createFileRoute } from '@tanstack/react-router';
import { WorktreesView } from '@/components/views/worktrees-view';

export const Route = createFileRoute('/worktrees')({
  component: WorktreesView,
});
