import { newIdempotencyKey } from '@/api/idempotency';

describe('newIdempotencyKey', () => {
  it('fits the backend’s 8-64 character bound', () => {
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('is unique per call', () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
  });
});
