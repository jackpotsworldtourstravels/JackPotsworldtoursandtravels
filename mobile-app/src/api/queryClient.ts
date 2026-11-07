import { QueryClient } from '@tanstack/react-query';

import { isApiError } from './errors';

/** Read-only requests: retry transient failures twice, never client errors. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && isApiError(error) && error.retryable;
}

/**
 * Server-state cache defaults.
 *
 * - Queries (GET) retry transient failures with backoff.
 * - Mutations NEVER retry (`retry: false`): a repeated booking or payment call
 *   is a duplicate booking or payment. A failed write is shown to the customer,
 *   who presses the button again; the idempotency key (idempotency.ts) makes
 *   that second press safe.
 * - No refetch-on-focus: React Native has no tab focus, and catalogue data
 *   changes rarely. Screens refetch explicitly (pull to refresh) when it matters.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
