/**
 * A stand-in for `@/api/endpoints/account`, wired into a test file with
 *
 *   jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
 *
 * Every read answers with an empty list unless the test says otherwise, so a
 * screen that merely asks for the wishlist or saved travellers in the background
 * never reaches a real network. Tests reach the functions through `accountApi`.
 */
const fn = <T>(value: T) => jest.fn(async (..._args: unknown[]) => value);

export const accountApiModule = {
  profileApi: { update: fn<unknown>(undefined), sessions: fn<unknown[]>([]) },
  wishlistApi: { list: fn<unknown[]>([]), add: fn<unknown>(undefined), remove: fn<void>(undefined) },
  travellerApi: { list: fn<unknown[]>([]), create: fn<unknown>(undefined), update: fn<unknown>(undefined), remove: fn<void>(undefined) },
  supportApi: { list: fn<unknown[]>([]), get: fn<unknown>(undefined), create: fn<unknown>(undefined), reply: fn<unknown>(undefined) },
  cancellationApi: { request: fn<unknown>(undefined) },
};

type AccountApi = typeof accountApiModule;

/** The same object, typed loosely enough to call `.mockResolvedValue(...)` on any member. */
export const accountApi = accountApiModule as unknown as {
  [K in keyof AccountApi]: { [M in keyof AccountApi[K]]: jest.Mock };
};

/** Back to "everything is empty and nothing is saved", between tests. */
export function resetAccountApi() {
  accountApi.wishlistApi.list.mockReset().mockResolvedValue([]);
  accountApi.wishlistApi.add.mockReset();
  accountApi.wishlistApi.remove.mockReset().mockResolvedValue(undefined);
  accountApi.travellerApi.list.mockReset().mockResolvedValue([]);
  accountApi.travellerApi.create.mockReset();
  accountApi.travellerApi.update.mockReset();
  accountApi.travellerApi.remove.mockReset().mockResolvedValue(undefined);
  accountApi.supportApi.list.mockReset().mockResolvedValue([]);
  accountApi.supportApi.get.mockReset();
  accountApi.supportApi.create.mockReset();
  accountApi.supportApi.reply.mockReset();
  accountApi.profileApi.update.mockReset();
  accountApi.profileApi.sessions.mockReset().mockResolvedValue([]);
  accountApi.cancellationApi.request.mockReset();
}
