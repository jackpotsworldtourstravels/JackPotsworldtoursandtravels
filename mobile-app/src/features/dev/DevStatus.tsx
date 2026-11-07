import { useQuery } from '@tanstack/react-query';

import { systemApi } from '@/api/endpoints/system';
import { Button, Card, Text } from '@/components';
import { env } from '@/config/env';
import { useFlightCapability } from '@/hooks/useFlightCapability';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Development-only diagnostics: which backend the build points at, whether it
 * answers, what the flight probe decided and what the session looks like. It is
 * how a developer proves the API layer works end to end on a device before the
 * real screens exist. Nothing here renders in a release build.
 */
export function DevStatus() {
  const { status, customer } = useAuth();
  const flights = useFlightCapability();
  const health = useQuery({ queryKey: ['system', 'health'], queryFn: systemApi.health, staleTime: 0 });

  if (!__DEV__) return null;

  const backend = health.isPending
    ? 'checking…'
    : health.isError
      ? `unreachable (${health.error.message})`
      : health.data
        ? 'reachable'
        : 'answered, but not "ok"';

  return (
    <Card>
      <Text variant="eyebrow" color="goldInk">
        Development build
      </Text>
      <Text variant="small">API: {env.apiBaseUrl}</Text>
      <Text variant="small">Environment: {env.appEnv}</Text>
      <Text variant="small">Backend: {backend}</Text>
      <Text variant="small">
        Flights: {flights.isLoading ? 'checking…' : flights.enabled ? `on (${flights.provider})` : `off (${flights.provider ?? 'not reported'})`}
      </Text>
      <Text variant="small">
        Session: {status}
        {customer ? ` · ${customer.customer_code}` : ''}
      </Text>
      <Button
        title="Check again"
        variant="outline"
        onPress={() => void health.refetch()}
        loading={health.isFetching}
        fullWidth={false}
      />
    </Card>
  );
}
