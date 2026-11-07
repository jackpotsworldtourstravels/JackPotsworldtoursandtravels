import * as WebBrowser from 'expo-web-browser';

import { openHostedPage, RETURN_WAIT_MS, returnWaiter, type AppStateLike } from '@/features/booking/hostedPage';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const open = WebBrowser.openBrowserAsync as jest.Mock;

function fakeAppState(initial = 'active') {
  let listener: ((s: string) => void) | null = null;
  const remove = jest.fn(() => {
    listener = null;
  });
  const state: AppStateLike & { emit(s: string): void; remove: jest.Mock; listening(): boolean } = {
    currentState: initial,
    addEventListener: (_type, l) => {
      listener = l;
      return { remove };
    },
    emit: (s) => {
      state.currentState = s;
      listener?.(s);
    },
    remove,
    listening: () => listener !== null,
  };
  return state;
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

beforeEach(() => {
  jest.useFakeTimers();
  open.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('returnWaiter', () => {
  it('stays waiting while the app is in the foreground, and resolves when it leaves and comes back', async () => {
    const app = fakeAppState();
    const { wait } = returnWaiter(app);
    expect(await settled(wait)).toBe(false);

    app.emit('background');
    expect(await settled(wait)).toBe(false); // away is not back
    app.emit('active');
    expect(await settled(wait)).toBe(true);
    expect(app.remove).toHaveBeenCalledTimes(1); // and it stops listening
  });

  it('is not fooled by an "active" event before the app has left', async () => {
    const app = fakeAppState();
    const { wait } = returnWaiter(app);
    app.emit('active');
    expect(await settled(wait)).toBe(false);
  });

  it('counts an app that was already in the background when it started', async () => {
    const app = fakeAppState('background');
    const { wait } = returnWaiter(app);
    app.emit('active');
    expect(await settled(wait)).toBe(true);
  });

  it('gives up after its time limit rather than hanging forever, so the backend is still asked once', async () => {
    const app = fakeAppState();
    const { wait } = returnWaiter(app, 1000);
    jest.advanceTimersByTime(999);
    expect(await settled(wait)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await settled(wait)).toBe(true);
    expect(app.listening()).toBe(false);
  });

  it('can be cancelled, which also stops listening', async () => {
    const app = fakeAppState();
    const w = returnWaiter(app);
    w.cancel();
    expect(await settled(w.wait)).toBe(true);
    expect(app.listening()).toBe(false);
  });

  it('allows twenty minutes by default', () => {
    expect(RETURN_WAIT_MS).toBe(20 * 60_000);
  });
});

describe('opening the hosted page', () => {
  const URL = 'https://smartgateway.hdfcuat.bank.in/pay/abc';

  it('on Android does NOT report back when the page merely opens: it waits until the customer returns to the app', async () => {
    open.mockResolvedValue({ type: 'opened' });
    const app = fakeAppState();
    const p = openHostedPage(URL, 'android', app);

    await Promise.resolve();
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith(URL, expect.objectContaining({ dismissButtonStyle: 'close' }));
    expect(await settled(p)).toBe(false); // the customer is still on the bank's page

    app.emit('background'); // the browser took over
    app.emit('active'); // the customer came back
    await p;
    expect(app.listening()).toBe(false);
  });

  it('on Android, does not wait if the browser reports it is already finished', async () => {
    open.mockResolvedValue({ type: 'cancel' });
    const app = fakeAppState();
    await openHostedPage(URL, 'android', app);
    expect(app.listening()).toBe(false);
  });

  it('on iOS, resolves when the browser itself reports it has closed, with no app-state waiting', async () => {
    open.mockResolvedValue({ type: 'cancel' });
    const app = fakeAppState();
    await openHostedPage(URL, 'ios', app);
    expect(app.listening()).toBe(false);
  });

  it('rejects, and stops listening, if the page could not be opened at all', async () => {
    open.mockRejectedValue(new Error('no browser'));
    const app = fakeAppState();
    await expect(openHostedPage(URL, 'android', app)).rejects.toThrow('no browser');
    expect(app.listening()).toBe(false);
  });
});
