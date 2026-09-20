import { createFileRoute } from '@tanstack/react-router';
import { SimilarTasksView } from '@/components/views/similar-tasks-view';

export const Route = createFileRoute('/similar-tasks')({ component: SimilarTasksView });
