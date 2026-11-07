import { readFileSync } from 'fs';
import { resolve } from 'path';

import { parseEnv } from '@/config/env';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const eas = JSON.parse(read('eas.json'));
const gitignore = read('.gitignore').split(/\r?\n/).map((l) => l.trim());

/**
 * Release configuration that must never drift into something unsafe. Nothing here builds,
 * signs or publishes anything; it only reads the files.
 */
describe('eas.json', () => {
  const production = eas.build.production;

  it('builds production for the stores, as an Android app bundle', () => {
    expect(production.distribution).toBe('store');
    expect(production.android.buildType).toBe('app-bundle');
    expect(production.developmentClient).toBeUndefined();
    expect(production.ios?.simulator).toBeUndefined();
  });

  it('numbers builds on EAS’s servers, so a store upload can never reuse a build number', () => {
    expect(eas.cli.appVersionSource).toBe('remote');
    expect(production.autoIncrement).toBe(true);
  });

  it('points production at the live site over https, and the app’s own rules accept it', () => {
    const url = production.env.EXPO_PUBLIC_API_BASE_URL;
    expect(url).toBe('https://jackpotsworldtours.com');
    const parsed = parseEnv({ apiBaseUrl: url, appEnv: 'production', isDev: false, platform: 'android' });
    expect(parsed.apiBaseUrl).toBe(url);
    expect(parsed.appEnv).toBe('production');
  });

  it('puts only public settings in any profile: nothing that looks like a secret', () => {
    for (const profile of Object.values<{ env?: Record<string, string> }>(eas.build)) {
      for (const [key, value] of Object.entries(profile.env ?? {})) {
        expect(key).toMatch(/^EXPO_PUBLIC_/);
        expect(`${key}=${value}`).not.toMatch(/secret|password|token|private|apikey|api_key|key_id/i);
        expect(value).not.toMatch(/localhost|127\.0\.0\.1|10\.0\.2\.2/);
      }
    }
  });

  it('keeps internal test builds away from the live site: a preview build must be given its own address', () => {
    expect(eas.build.preview.distribution).toBe('internal');
    expect(eas.build.preview.env.EXPO_PUBLIC_API_BASE_URL).toBeUndefined();
    expect(eas.build.preview.env.EXPO_PUBLIC_APP_ENV).toBe('staging');
  });

  it('keeps the development-client build internal, an APK, and with no API address of its own (it can never reach the live site)', () => {
    const development = eas.build.development;
    expect(development.developmentClient).toBe(true);
    expect(development.distribution).toBe('internal');
    expect(development.android.buildType).toBe('apk');
    expect(development.env.EXPO_PUBLIC_APP_ENV).toBe('development');
    expect(development.env.EXPO_PUBLIC_API_BASE_URL).toBeUndefined();
  });

  it('submits to Google Play only as an internal-track draft, never straight to production', () => {
    expect(eas.submit.production.android).toEqual({ track: 'internal', releaseStatus: 'draft' });
  });
});

describe('what Git is told never to keep', () => {
  it.each(['*.jks', '*.keystore', 'credentials.json', '*.p8', '*.p12', '*.mobileprovision', '.env.*'])('ignores %s', (pattern) => {
    expect(gitignore).toContain(pattern);
  });

  it('still allows the documented .env.example template', () => {
    expect(gitignore).toContain('!.env.example');
  });
});
