import { readFileSync } from 'fs';
import { resolve } from 'path';

const config = JSON.parse(readFileSync(resolve(__dirname, '../../app.json'), 'utf8')).expo;
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));

/**
 * Settings that are easy to change by accident and costly to get wrong in a store build.
 * Each one was checked against the native config Expo actually generates (Phase 8).
 */
describe('app.json', () => {
  it('forbids plain-HTTP loads on iOS (the generated default allowed arbitrary loads), allowing only local-network development', () => {
    expect(config.ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true });
  });

  it('asks Android for no permission beyond the network: no storage, overlay or vibration', () => {
    expect(config.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.VIBRATE',
      ]),
    );
  });

  it('declares no permission-prompting capability the app does not use', () => {
    const text = JSON.stringify(config);
    for (const word of ['NSCameraUsageDescription', 'NSLocation', 'NSPhotoLibrary', 'NSMicrophone', 'NSContacts']) {
      expect(text).not.toContain(word);
    }
  });

  it('keeps tokens out of backups: expo-secure-store is configured through its plugin', () => {
    expect(config.plugins).toContain('expo-secure-store');
  });

  it('has a deep-link scheme and store identifiers (the identifiers are placeholders to confirm before upload)', () => {
    expect(config.scheme).toBe('jackpotsworld');
    expect(config.ios.bundleIdentifier).toBe(config.android.package);
  });

  it('keeps the light theme on Android, which needs expo-system-ui to apply', () => {
    expect(config.userInterfaceStyle).toBe('light');
    expect(pkg.dependencies['expo-system-ui']).toBeDefined();
  });
});
