import { FLIGHTS_OFF, interpretFlightProbe, systemApi } from '@/api/endpoints/system';

jest.mock('@/api/client', () => ({ http: { get: jest.fn() } }));
const mockedGet = (require('@/api/client') as { http: { get: jest.Mock } }).http.get;

describe('interpretFlightProbe', () => {
  it('is OFF for the demo supplier, which is what production reports today', () => {
    expect(interpretFlightProbe({ provider: 'demo', currency: null, results: [], note: 'x' })).toEqual({
      enabled: false,
      provider: 'demo',
    });
    expect(interpretFlightProbe({ provider: 'DEMO' }).enabled).toBe(false);
  });

  it('is ON only when the backend names a supplier other than demo', () => {
    expect(interpretFlightProbe({ provider: 'duffel' })).toEqual({ enabled: true, provider: 'duffel' });
    expect(interpretFlightProbe({ provider: 'tbo' })).toEqual({ enabled: true, provider: 'tbo' });
  });

  it.each([null, undefined, 'demo', 42, [], {}, { provider: '' }, { provider: 7 }, { provider: '   ' }])(
    'fails closed for %p',
    (body) => {
      expect(interpretFlightProbe(body).enabled).toBe(false);
    },
  );
});

describe('systemApi.flightCapability', () => {
  beforeEach(() => mockedGet.mockReset());

  it('reads the provider from the unauthenticated probe', async () => {
    mockedGet.mockResolvedValue({ data: { provider: 'demo', results: [] } });
    await expect(systemApi.flightCapability()).resolves.toEqual({ enabled: false, provider: 'demo' });
    expect(mockedGet).toHaveBeenCalledWith('/api/customer/flights/search', { skipAuth: true });
  });

  it('turns on for a real supplier', async () => {
    mockedGet.mockResolvedValue({ data: { provider: 'duffel', results: [] } });
    await expect(systemApi.flightCapability()).resolves.toMatchObject({ enabled: true });
  });

  it('stays OFF when the call fails, whatever the reason', async () => {
    mockedGet.mockRejectedValue(new Error('network'));
    await expect(systemApi.flightCapability()).resolves.toEqual(FLIGHTS_OFF);
  });
});
