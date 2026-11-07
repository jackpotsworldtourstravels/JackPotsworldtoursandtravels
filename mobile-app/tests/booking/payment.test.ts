import { ApiError } from '@/api/errors';
import { confirmPayment, isSafeRedirect, runPayment, RECONCILE_DELAYS_MS, type PaymentDeps } from '@/features/booking/payment';

import { checkout, hotelBooking, payment, reconcile } from '../fixtures/booking';

const PAID = reconcile({ booking_status: 'confirmed', payment_status: 'captured', captured: true, code: 'captured', retryable: false });
const PENDING = reconcile();

function deps(over: Partial<PaymentDeps> = {}): PaymentDeps & { calls: string[] } {
  const calls: string[] = [];
  const d: PaymentDeps = {
    config: async () => {
      calls.push('config');
      return { configured: true, mode: 'real' };
    },
    checkout: async (_kind, ref, key) => {
      calls.push(`checkout:${ref}:${key}`);
      return checkout;
    },
    reconcile: async () => {
      calls.push('reconcile');
      return PAID;
    },
    openBrowser: async (url) => {
      calls.push(`browser:${url}`);
    },
    sleep: async () => {
      calls.push('sleep');
    },
    ...over,
  };
  return Object.assign(d, { calls });
}

describe('runPayment: the backend is the only judge', () => {
  it('walks config, checkout, hosted page, reconcile, and reports paid only from the server’s answer', async () => {
    const d = deps();
    const result = await runPayment('hotel', hotelBooking(), d);

    expect(result).toMatchObject({ kind: 'outcome', outcome: 'paid' });
    expect(d.calls).toEqual(['config', 'checkout:JPH000123:pay-JPH000123-1', `browser:${checkout.redirect_url}`, 'reconcile']);
  });

  it('does NOT call a payment paid just because the browser closed', async () => {
    const d = deps({ reconcile: async () => PENDING });
    const result = await runPayment('hotel', hotelBooking(), d);
    expect(result).toMatchObject({ kind: 'outcome', outcome: 'waiting' });
  });

  it('does NOT call it confirmed when money arrived but the booking is not confirmed', async () => {
    const d = deps({ reconcile: async () => reconcile({ payment_status: 'captured', booking_status: 'pending', captured: true }) });
    expect(await runPayment('hotel', hotelBooking(), d)).toMatchObject({ outcome: 'received_unconfirmed' });
  });

  it('stops before opening anything when online payment is not configured', async () => {
    const d = deps({ config: async () => ({ configured: false, mode: 'real' }) });
    const result = await runPayment('hotel', hotelBooking(), d);
    expect(result.kind).toBe('unavailable');
    expect(d.calls).toEqual([]);
  });

  it('refuses demo mode, which can take no money, rather than showing a payment that cannot finish', async () => {
    const calls: string[] = [];
    const d = deps({
      config: async () => ({ configured: true, mode: 'demo' }),
      checkout: async () => {
        calls.push('checkout');
        return checkout;
      },
    });
    const result = await runPayment('hotel', hotelBooking(), d);
    expect(result).toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/demo/i) });
    expect(calls).toEqual([]);
  });

  it('shows the server’s own sentence when checkout is refused, and opens no browser', async () => {
    const d = deps({
      checkout: async () => {
        throw new ApiError('validation', { status: 400, message: 'JPH000123 was held for 30 minutes and that time has passed.' });
      },
    });
    const result = await runPayment('hotel', hotelBooking(), d);
    expect(result).toEqual({ kind: 'error', message: 'JPH000123 was held for 30 minutes and that time has passed.' });
    expect(d.calls.some((c) => c.startsWith('browser'))).toBe(false);
  });

  it('says plainly when the provider offers no hosted page (a drop-in checkout the app cannot open)', async () => {
    const d = deps({ checkout: async () => ({ ...checkout, redirect_url: null }) });
    const result = await runPayment('hotel', hotelBooking(), d);
    expect(result.kind).toBe('unavailable');
    expect(d.calls.some((c) => c.startsWith('browser') || c === 'reconcile')).toBe(false);
  });

  it('never opens a URL that is not https', async () => {
    const d = deps({ checkout: async () => ({ ...checkout, redirect_url: 'http://pay.example.com/x' }) });
    expect((await runPayment('hotel', hotelBooking(), d)).kind).toBe('unavailable');
    expect(d.calls.some((c) => c.startsWith('browser'))).toBe(false);
  });

  it('still asks the backend if the browser could not open: the customer may have paid earlier', async () => {
    const d = deps({
      openBrowser: async () => {
        throw new Error('no browser');
      },
    });
    expect(await runPayment('hotel', hotelBooking(), d)).toMatchObject({ outcome: 'paid' });
  });

  it('sends the SAME key on the next press while an attempt is open, and a NEW one after a failure', async () => {
    const open = deps();
    await runPayment('hotel', hotelBooking({ payments: [payment('pending')] }), open);
    expect(open.calls).toContain('checkout:JPH000123:pay-JPH000123-1');

    const failed = deps();
    await runPayment('hotel', hotelBooking({ payments: [payment('failed')] }), failed);
    expect(failed.calls).toContain('checkout:JPH000123:pay-JPH000123-2');
  });

  it('sends no amount: checkout takes only the booking reference and a key', async () => {
    const seen: unknown[][] = [];
    const d = deps({
      checkout: async (...args) => {
        seen.push(args);
        return checkout;
      },
    });
    await runPayment('package', { ...hotelBooking(), booking_ref: 'JPP000045' }, d);
    expect(seen[0]).toEqual(['package', 'JPP000045', 'pay-JPP000045-1']);
  });
});

describe('confirmPayment: asking until the answer is final', () => {
  it('keeps asking through "waiting" and stops at the first final answer', async () => {
    let n = 0;
    const slept: number[] = [];
    const result = await confirmPayment(
      'hotel',
      'JPH000123',
      {
        reconcile: async () => (++n < 3 ? PENDING : PAID),
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      undefined,
      [0, 10, 20, 30, 40],
    );
    expect(result).toMatchObject({ outcome: 'paid' });
    expect(n).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it('gives up after its budget and reports "waiting", never "paid" or "failed"', async () => {
    let n = 0;
    const result = await confirmPayment(
      'hotel',
      'JPH000123',
      { reconcile: async () => (n++, PENDING), sleep: async () => undefined },
      undefined,
      [0, 1, 1],
    );
    expect(result).toMatchObject({ kind: 'outcome', outcome: 'waiting' });
    expect(n).toBe(3);
  });

  it('treats a failed ask as "unknown", not "failed", and tries again', async () => {
    let n = 0;
    const result = await confirmPayment(
      'hotel',
      'JPH000123',
      {
        reconcile: async () => {
          if (++n === 1) throw new ApiError('network');
          return PAID;
        },
        sleep: async () => undefined,
      },
      undefined,
      [0, 1],
    );
    expect(result).toMatchObject({ outcome: 'paid' });
  });

  it('reports an error only when it could never get an answer', async () => {
    const result = await confirmPayment(
      'hotel',
      'JPH000123',
      {
        reconcile: async () => {
          throw new ApiError('timeout');
        },
        sleep: async () => undefined,
      },
      undefined,
      [0, 1, 1],
    );
    expect(result.kind).toBe('error');
  });

  it('reports progress, and stops when told the screen has gone', async () => {
    const steps: number[] = [];
    let stop = false;
    await confirmPayment(
      'hotel',
      'JPH000123',
      {
        reconcile: async () => {
          stop = true;
          return PENDING;
        },
        sleep: async () => undefined,
      },
      (p) => p.step === 'confirming' && steps.push(p.attempt),
      [0, 1, 1, 1],
      () => stop,
    );
    expect(steps).toEqual([1]);
  });

  it('final answers end the loop immediately: failed, expired, cancelled', async () => {
    for (const status of ['failed', 'expired', 'cancelled'] as const) {
      let n = 0;
      const result = await confirmPayment(
        'hotel',
        'JPH000123',
        { reconcile: async () => (n++, reconcile({ payment_status: status, retryable: false })), sleep: async () => undefined },
        undefined,
        [0, 1, 1],
      );
      expect(result).toMatchObject({ outcome: status });
      expect(n).toBe(1);
    }
  });

  it('has a budget of about a minute', () => {
    expect(RECONCILE_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(45_000);
    expect(RECONCILE_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90_000);
  });
});

describe('isSafeRedirect', () => {
  it('accepts https only', () => {
    expect(isSafeRedirect('https://smartgateway.hdfc.example/pay')).toBe(true);
    for (const bad of ['http://x.com', 'javascript:alert(1)', 'jackpotsworld://x', 'not a url', '', null, undefined]) {
      expect(isSafeRedirect(bad as string)).toBe(false);
    }
  });
});
