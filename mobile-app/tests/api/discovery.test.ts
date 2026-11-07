import { discoveryApi } from '@/api/endpoints/discovery';

jest.mock('@/api/client', () => ({ http: { get: jest.fn() } }));
const get = (require('@/api/client') as { http: { get: jest.Mock } }).http.get;

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: [] });
});

describe('discovery requests', () => {
  it('are all public: no session, so no token and no refresh for a browsing visitor', async () => {
    await discoveryApi.destinations();
    await discoveryApi.hotels();
    await discoveryApi.packages();
    await discoveryApi.locations('goa');
    await discoveryApi.attractions('goa');
    await discoveryApi.destinationHotels('goa');
    await discoveryApi.coupons('hotel');
    for (const call of get.mock.calls) expect(call[1]).toMatchObject({ skipAuth: true });
  });

  it('hits the documented customer routes', async () => {
    await discoveryApi.destinations();
    await discoveryApi.hotels();
    await discoveryApi.locations('goa');
    await discoveryApi.attractions('goa');
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/api/customer/destinations',
      '/api/customer/hotels',
      '/api/customer/destinations/goa/locations',
      '/api/customer/destinations/goa/attractions',
    ]);
  });

  it('encodes a path segment that came off the network', async () => {
    await discoveryApi.locations('a/b?c');
    expect(get.mock.calls[0][0]).toBe('/api/customer/destinations/a%2Fb%3Fc/locations');
  });

  it('passes paging and location filters to a destination’s hotels', async () => {
    await discoveryApi.destinationHotels('hyderabad', { page: 2, pageSize: 10, locationId: 'hyderabad__hitec-city' });
    expect(get).toHaveBeenCalledWith('/api/customer/destinations/hyderabad/hotels', {
      skipAuth: true,
      params: { location_id: 'hyderabad__hitec-city', page: 2, page_size: 10 },
    });
  });

  it('always names the product when asking for offers, so a flight offer never reaches an app that does not sell flights', async () => {
    await discoveryApi.coupons('hotel');
    await discoveryApi.coupons('package');
    expect(get.mock.calls.map((c) => c[1].params)).toEqual([{ product_type: 'hotel' }, { product_type: 'package' }]);
  });

  it('filters packages on the server', async () => {
    await discoveryApi.packages({ destination: 'Goa', trip_type: 'domestic' });
    expect(get).toHaveBeenCalledWith('/api/customer/packages', {
      skipAuth: true,
      params: { destination: 'Goa', trip_type: 'domestic' },
    });
  });

  it('returns the response body', async () => {
    get.mockResolvedValue({ data: [{ id: 'goa' }] });
    await expect(discoveryApi.destinations()).resolves.toEqual([{ id: 'goa' }]);
  });
});
