import { useSingleFlight } from './useSingleFlight';

/**
 * Wrap an async action so a second press while the first is still running does
 * nothing. A mutation's own "pending" flag cannot do this alone: it reaches the
 * screen a moment after the tap, and two taps in that moment would both go out
 * (for a delete, the second one then fails with "not found" and shows an error
 * for something that worked). The guard is a ref, set synchronously.
 *
 * Failures are not thrown here: pass a mutation's `mutateAsync` and its own
 * `error` state is what the screen shows.
 */
export function useOnce<TArgs extends unknown[]>(run: (...args: TArgs) => Promise<unknown>) {
  const singleFlight = useSingleFlight();
  return (...args: TArgs): void => {
    void singleFlight(async () => {
      try {
        await run(...args);
      } catch {
        // Reported through the mutation's error state.
      }
    });
  };
}
