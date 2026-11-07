import { hotelApi, packageApi, paymentsApi } from '@/api/endpoints/booking';

jest.mock('@/api/client', () => ({ http: { get: jest.fn(), post: jest.fn() } }));
const { get, post } = (require('@/api/client') as { http: { get: jest.Mock; post: jest.Mock } }).http;

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: {} });
  post.mockReset().mockResolvedValue({ data: {} });
});

describe('what needs no session', () => {
  it('reading a page and asking for a quote carry no token and cannot trigger a refresh', async () => {
    await hotelApi.detail(1);
    await packageApi.detail(7);
    await hotelApi.quote({ stay: {} as never, addons: [] });
    await packageApi.quote({ trip: {} as never, addons: [] });
    await packageApi.enquire({} as never);
    await paymentsApi.config('JPH000123');
    for (const call of [...get.mock.calls, ...post.mock.calls]) {
      expect(call[call.length - 1]).toMatchObject({ skipAuth: true });
    }
  });
});

describe('what is the customer’s own', () => {
  it('creating, reading, paying and cancelling a booking use the authenticated client', async () => {
    await hotelApi.create({ idempotency_key: 'k-12345678' } as never);
    await hotelApi.get('JPH000123');
    await hotelApi.list();
    await hotelApi.cancel('JPH000123');
    await hotelApi.checkout('JPH000123', 'pay-JPH000123-1');
    await hotelApi.reconcile('JPH000123');
    await packageApi.create({ idempotency_key: 'k-12345678' } as never);
    await packageApi.get('JPP000045');
    await packageApi.list();
    await packageApi.cancel('JPP000045');
    await packageApi.checkout('JPP000045', 'pay-JPP000045-1');
    await packageApi.reconcile('JPP000045');

    for (const call of [...get.mock.calls, ...post.mock.calls]) {
      const config = call[call.length - 1];
      expect(config?.skipAuth).toBeUndefined();
    }
  });
});

describe('endpoints and bodies', () => {
  it('hits the documented routes', async () => {
    await hotelApi.detail(12);
    await packageApi.detail(7);
    await hotelApi.get('JPH000123');
    await packageApi.get('JPP000045');
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/api/customer/hotels/12',
      '/api/customer/packages/7',
      '/api/customer/hotel-bookings/JPH000123',
      '/api/customer/package-bookings/JPP000045',
    ]);
  });

  it('checkout sends the idempotency key and nothing else: no amount, no currency', async () => {
    await hotelApi.checkout('JPH000123', 'pay-JPH000123-1');
    await packageApi.checkout('JPP000045', 'pay-JPP000045-2');
    expect(post).toHaveBeenNthCalledWith(1, '/api/customer/hotel-bookings/JPH000123/checkout', { idempotency_key: 'pay-JPH000123-1' });
    expect(post).toHaveBeenNthCalledWith(2, '/api/customer/package-bookings/JPP000045/checkout', { idempotency_key: 'pay-JPP000045-2' });
  });

  it('reconcile sends an empty body: nothing the browser says decides anything', async () => {
    await hotelApi.reconcile('JPH000123');
    expect(post).toHaveBeenCalledWith('/api/customer/hotel-bookings/JPH000123/reconcile', {});
  });

  it('create sends the request exactly as built, key included', async () => {
    const body = { idempotency_key: 'abc-12345678', stay: { hotel_id: 1 } } as never;
    await hotelApi.create(body);
    expect(post).toHaveBeenCalledWith('/api/customer/hotel-bookings', body);
  });

  it('asks about payment per booking', async () => {
    await paymentsApi.config('JPH000123');
    await paymentsApi.config();
    expect(get.mock.calls[0][1]).toMatchObject({ params: { booking_ref: 'JPH000123' } });
    expect(get.mock.calls[1][1].params).toBeUndefined();
  });

  it('encodes anything that came off the network into a path', async () => {
    await hotelApi.get('JPH000123/../x');
    expect(get.mock.calls[0][0]).toBe('/api/customer/hotel-bookings/JPH000123%2F..%2Fx');
  });
});
