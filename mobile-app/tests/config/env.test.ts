import { parseEnv, type RawEnv } from '@/config/env';

const dev = (over: Partial<RawEnv> = {}): RawEnv => ({ isDev: true, platform: 'android', ...over });
const release = (over: Partial<RawEnv> = {}): RawEnv => ({ isDev: false, platform: 'ios', ...over });

describe('parseEnv', () => {
  it('accepts an https origin and strips a trailing slash', () => {
    expect(parseEnv(release({ apiBaseUrl: 'https://api.example.com/', appEnv: 'production' }))).toEqual({
      apiBaseUrl: 'https://api.example.com',
      appEnv: 'production',
    });
  });

  it('keeps a port', () => {
    expect(parseEnv(release({ apiBaseUrl: 'https://staging.example.com:8443', appEnv: 'staging' })).apiBaseUrl).toBe(
      'https://staging.example.com:8443',
    );
  });

  it('refuses plain http in a release build', () => {
    expect(() => parseEnv(release({ apiBaseUrl: 'http://api.example.com', appEnv: 'production' }))).toThrow(/https/);
  });

  it('refuses plain http for staging even in a development build', () => {
    expect(() => parseEnv(dev({ apiBaseUrl: 'http://staging.example.com', appEnv: 'staging' }))).toThrow(/https/);
  });

  it('allows plain http for a development build in the development environment', () => {
    expect(parseEnv(dev({ apiBaseUrl: 'http://192.168.1.20:8000', appEnv: 'development' })).apiBaseUrl).toBe(
      'http://192.168.1.20:8000',
    );
  });

  it('falls back to the emulator host in development, per platform', () => {
    expect(parseEnv(dev({ platform: 'android' })).apiBaseUrl).toBe('http://10.0.2.2:8000');
    expect(parseEnv(dev({ platform: 'ios' })).apiBaseUrl).toBe('http://127.0.0.1:8000');
  });

  it('never guesses an address in a release build', () => {
    expect(() => parseEnv(release())).toThrow(/EXPO_PUBLIC_API_BASE_URL is not set/);
  });

  it('rejects a path, query or garbage', () => {
    expect(() => parseEnv(release({ apiBaseUrl: 'https://api.example.com/api', appEnv: 'production' }))).toThrow(/origin only/);
    expect(() => parseEnv(release({ apiBaseUrl: 'https://api.example.com/?x=1', appEnv: 'production' }))).toThrow(/origin only/);
    expect(() => parseEnv(release({ apiBaseUrl: 'not a url', appEnv: 'production' }))).toThrow(/not a valid URL/);
    expect(() => parseEnv(release({ apiBaseUrl: 'ftp://api.example.com', appEnv: 'production' }))).toThrow();
  });

  it('rejects an unknown environment name', () => {
    expect(() => parseEnv(dev({ appEnv: 'prod' }))).toThrow(/EXPO_PUBLIC_APP_ENV/);
  });

  it('defaults the environment from the build type', () => {
    expect(parseEnv(dev()).appEnv).toBe('development');
    expect(parseEnv(release({ apiBaseUrl: 'https://api.example.com' })).appEnv).toBe('production');
  });
});
