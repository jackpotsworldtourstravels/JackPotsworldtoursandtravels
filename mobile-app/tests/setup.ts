/**
 * Global Jest setup.
 *
 * SecureStore is replaced with an in-memory Map so token persistence can be
 * asserted without a device, and `__secureStoreForTests` lets a test read what
 * was actually written. expo-crypto's randomUUID is backed by Node's crypto.
 */
const mockSecureStoreData = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (key: string) => mockSecureStoreData.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreData.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStoreData.delete(key);
  }),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => require('crypto').randomUUID(),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, data: string) =>
    require('crypto').createHash('sha256').update(data).digest('hex'),
}));

// The real icon set loads a font file through the asset registry, which Jest
// has no device to serve. A stub that renders nothing visible keeps component
// tests about behaviour rather than glyphs.
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Ionicons = ({ name }: { name: string }) =>
    React.createElement(View, { testID: `icon-${name}`, accessibilityElementsHidden: true });
  Ionicons.glyphMap = {};
  return { Ionicons };
});

// Screens read the safe-area insets; Jest has no device to measure.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

(globalThis as { __secureStoreForTests?: Map<string, string> }).__secureStoreForTests = mockSecureStoreData;

// The first render of a screen on a slow disk, or in a busy parallel run, can take longer than Jest's default
// five seconds for a whole test. This only widens the ceiling; a test that hangs still fails.
jest.setTimeout(20_000);

require('@testing-library/react-native').configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  mockSecureStoreData.clear();
});
