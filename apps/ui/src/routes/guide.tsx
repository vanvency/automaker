import { createFileRoute } from '@tanstack/react-router';
import { GuideView } from '@/components/views/guide-view';

export const Route = createFileRoute('/guide')({
  component: GuideView,
});
