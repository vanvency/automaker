import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/running-agents')({
  beforeLoad: () => {
    throw redirect({ to: '/agent' });
  },
});
