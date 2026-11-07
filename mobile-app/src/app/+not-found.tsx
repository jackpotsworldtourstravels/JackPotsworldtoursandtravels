import { useRouter } from 'expo-router';

import { EmptyState, Screen } from '@/components';

export default function NotFound() {
  const router = useRouter();
  return (
    <Screen header>
      <EmptyState
        icon="map-outline"
        title="We couldn't find that page"
        message="The link may be old or mistyped."
        actionLabel="Back to home"
        onAction={() => router.replace('/')}
      />
    </Screen>
  );
}
