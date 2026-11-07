import {
  ATTEMPT_TTL_MS,
  _resetAttemptMemoryForTests,
  dropEntry,
  fingerprint,
  forget,
  keyFor,
  pickKey,
  stableStringify,
  type AttemptEntry,
} from '@/features/booking/attempts';

const store = () => (globalThis as { __secureStoreForTests?: Map<string, string> }).__secureStoreForTests!;

const request = () => ({
  stay: { hotel_id: 1, room_id: 2, check_in: '2026-11-05', check_out: '2026-11-08', rooms_count: 1, adults: 2, children: 0 },
  guests: [{ first_name: 'Asha', last_name: 'Rao', is_contact: true, email: 'asha@example.com', mobile: '+919876543210' }],
  coupon_code: null,
});

beforeEach(() => _resetAttemptMemoryForTests());

describe('stableStringify and fingerprint', () => {
  it('serialises equal objects equally, whatever order their keys were written in', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(stableStringify({ a: { c: 'x', d: [1, 2] }, b: 1 }));
  });

  it('keeps array order, because order is meaning', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('ignores undefined fields, as JSON does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('is the same for the same booking and different for any change to it', async () => {
    const base = await fingerprint('hotel', request());
    expect(await fingerprint('hotel', request())).toBe(base);

    const renamed = request();
    renamed.guests[0].first_name = 'Asha ';
    expect(await fingerprint('hotel', renamed)).not.toBe(base);

    const moved = request();
    moved.stay.check_in = '2026-11-06';
    expect(await fingerprint('hotel', moved)).not.toBe(base);

    expect(await fingerprint('hotel', { ...request(), coupon_code: 'STAYMORE' })).not.toBe(base);
    expect(await fingerprint('package', request())).not.toBe(base);
  });

  it('does not include the idempotency key, so adding it cannot change the fingerprint', async () => {
    expect(await fingerprint('hotel', { ...request(), idempotency_key: 'abc-12345678' })).toBe(await fingerprint('hotel', request()));
  });
});

describe('pickKey', () => {
  const now = 1_000_000;
  const entry = (hash: string, key: string, at = now): AttemptEntry => ({ hash, key, at });

  it('reuses the key for an identical request', () => {
    const { key } = pickKey([entry('h1', 'key-one-1234')], 'h1', now + 1000, () => 'NEW-KEY-9999');
    expect(key).toBe('key-one-1234');
  });

  it('makes a new key for a different request, and keeps the old one', () => {
    const { key, entries } = pickKey([entry('h1', 'key-one-1234')], 'h2', now + 1000, () => 'key-two-5678');
    expect(key).toBe('key-two-5678');
    expect(entries.map((e) => e.hash)).toEqual(['h1', 'h2']);
  });

  it('forgets an attempt after an hour: by then the booking exists or the attempt is dead', () => {
    const { key, entries } = pickKey([entry('h1', 'old-key-1234')], 'h1', now + ATTEMPT_TTL_MS, () => 'fresh-key-777');
    expect(key).toBe('fresh-key-777');
    expect(entries.find((e) => e.key === 'old-key-1234')).toBeUndefined();
  });

  it('is still the same key one millisecond before the hour is up', () => {
    expect(pickKey([entry('h1', 'k-12345678')], 'h1', now + ATTEMPT_TTL_MS - 1).key).toBe('k-12345678');
  });

  it('keeps only a handful of recent attempts', () => {
    let entries: AttemptEntry[] = [];
    for (let i = 0; i < 20; i += 1) entries = pickKey(entries, `h${i}`, now, () => `key-${i}-12345678`).entries;
    expect(entries.length).toBeLessThanOrEqual(8);
    expect(entries.at(-1)?.hash).toBe('h19');
  });

  it('drops one entry by hash', () => {
    expect(dropEntry([entry('a', 'ka-12345678'), entry('b', 'kb-12345678')], 'a').map((e) => e.hash)).toEqual(['b']);
  });
});

describe('keyFor (what the screens call)', () => {
  it('sends the SAME key when the same booking is attempted again, even after a restart', async () => {
    const first = await keyFor('hotel', request());
    _resetAttemptMemoryForTests(); // the app was killed; only SecureStore survives
    expect(await keyFor('hotel', request())).toBe(first);
  });

  it('sends a NEW key as soon as anything about the booking changes', async () => {
    const first = await keyFor('hotel', request());
    const edited = request();
    edited.guests[0].last_name = 'Rau';
    expect(await keyFor('hotel', edited)).not.toBe(first);
  });

  it('gives a fresh key to the same trip booked again on purpose, once the first has been shown', async () => {
    const first = await keyFor('hotel', request());
    await forget('hotel', request());
    expect(await keyFor('hotel', request())).not.toBe(first);
  });

  it('expires an old attempt', async () => {
    const t0 = 5_000_000;
    const first = await keyFor('hotel', request(), t0);
    expect(await keyFor('hotel', request(), t0 + ATTEMPT_TTL_MS + 1)).not.toBe(first);
  });

  it('produces keys the backend accepts: 8 to 64 characters', async () => {
    const key = await keyFor('package', request());
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('stores no names, emails or phone numbers: only an opaque hash and a random key', async () => {
    await keyFor('hotel', request());
    const stored = [...store().values()].join(' ');
    expect(stored).toContain('hash');
    for (const secret of ['Asha', 'Rao', 'asha@example.com', '9876543210']) expect(stored).not.toContain(secret);
  });

  it('survives a corrupted record by simply issuing a new key', async () => {
    store().set('jp.booking_attempts', '{not json');
    await expect(keyFor('hotel', request())).resolves.toMatch(/.{8,}/);
  });
});
