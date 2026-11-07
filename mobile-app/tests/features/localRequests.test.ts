import * as SecureStore from 'expo-secure-store';

import { readDeletionRequest, recordDeletionRequest } from '@/features/account/localRequests';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when_unlocked_this_device_only',
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    __store: store,
  };
});

const secure = SecureStore as jest.Mocked<typeof SecureStore> & { __store: Map<string, string> };

beforeEach(() => {
  secure.__store.clear();
  secure.setItemAsync.mockClear();
  secure.getItemAsync.mockClear();
});

describe('remembering that a deletion request was sent', () => {
  it('remembers the date, per account, on this phone only', async () => {
    const at = new Date('2026-10-22T10:00:00Z');
    await recordDeletionRequest('CUS-000001', at);
    expect(await readDeletionRequest('CUS-000001')).toBe(at.toISOString());
    expect(await readDeletionRequest('CUS-000002')).toBeNull();
    expect(secure.setItemAsync).toHaveBeenCalledWith('deletion-asked.CUS-000001', at.toISOString(), expect.objectContaining({ keychainAccessible: 'when_unlocked_this_device_only' }));
  });

  it('keeps only a date and the account code in the key: no name, email or message', async () => {
    await recordDeletionRequest('CUS-000001', new Date('2026-10-22T10:00:00Z'));
    const [k, v] = secure.setItemAsync.mock.calls[0];
    expect(k).toBe('deletion-asked.CUS-000001');
    expect(v).toMatch(/^2026-10-22T10:00:00\.000Z$/);
  });

  it('makes a code safe for the store’s key rules', async () => {
    await recordDeletionRequest('a b/c', new Date('2026-10-22T10:00:00Z'));
    expect(secure.setItemAsync.mock.calls[0][0]).toBe('deletion-asked.a_b_c');
  });

  it('treats an unreadable value as nothing remembered', async () => {
    secure.__store.set('deletion-asked.CUS-000001', 'not a date');
    expect(await readDeletionRequest('CUS-000001')).toBeNull();
  });

  it('a store that fails never turns a sent request into an error', async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error('locked'));
    await expect(recordDeletionRequest('CUS-000001')).resolves.toBeUndefined();
    secure.getItemAsync.mockRejectedValueOnce(new Error('locked'));
    await expect(readDeletionRequest('CUS-000001')).resolves.toBeNull();
  });
});
