import { useCallback, useRef } from 'react';

/**
 * Run an async action at most once at a time.
 *
 * `run(work)` starts `work` only if no earlier call is still unfinished; a second
 * call while one is running returns `undefined` immediately and does nothing. A
 * flag held in a ref (not state) is the point: two taps in the same instant both
 * see "not running" in a state-based guard, because state has not re-rendered
 * yet, and both would send a booking. A ref is updated synchronously.
 *
 * It protects ONE screen from itself. It does not replace the idempotency key,
 * which is what protects the customer across retries, restarts and devices.
 */
export function useSingleFlight() {
  const running = useRef(false);

  return useCallback(async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (running.current) return undefined;
    running.current = true;
    try {
      return await work();
    } finally {
      running.current = false;
    }
  }, []);
}
