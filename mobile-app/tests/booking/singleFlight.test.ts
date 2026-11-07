import { renderHook } from '@testing-library/react-native';

import { useSingleFlight } from '@/hooks/useSingleFlight';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSingleFlight', () => {
  it('runs the work once however many times it is pressed while it is running', async () => {
    const { result } = await renderHook(() => useSingleFlight());
    const gate = deferred<string>();
    const work = jest.fn(() => gate.promise);

    const first = result.current(work);
    const second = result.current(work);
    const third = result.current(work);

    gate.resolve('booked');
    expect(await first).toBe('booked');
    expect(await second).toBeUndefined();
    expect(await third).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('allows the next press once the work has finished', async () => {
    const { result } = await renderHook(() => useSingleFlight());
    const work = jest.fn(async () => 'ok');
    await result.current(work);
    await result.current(work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('lets go when the work fails, so the customer can try again', async () => {
    const { result } = await renderHook(() => useSingleFlight());
    await expect(result.current(async () => Promise.reject(new Error('timeout')))).rejects.toThrow('timeout');
    const retry = jest.fn(async () => 'second try');
    expect(await result.current(retry)).toBe('second try');
  });
});

describe('useOnce', () => {
  it('runs an action once however many times it is pressed while it is running, then again once it has finished', async () => {
    const { useOnce } = require('@/hooks/useOnce') as typeof import('@/hooks/useOnce');
    const gate = deferred<void>();
    const run = jest.fn((_id: number) => gate.promise);
    const { result } = await renderHook(() => useOnce(run));

    result.current(1);
    result.current(1);
    result.current(1);
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    result.current(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(2);
  });

  it('does not throw when the action fails (the mutation’s own error state is what the screen shows), and can be pressed again', async () => {
    const { useOnce } = require('@/hooks/useOnce') as typeof import('@/hooks/useOnce');
    const run = jest.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue(undefined);
    const { result } = await renderHook(() => useOnce(run));

    expect(() => result.current()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    result.current();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
