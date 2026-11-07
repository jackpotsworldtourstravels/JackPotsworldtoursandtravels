import { AxiosError } from 'axios';

import { ApiError, toApiError } from '@/api/errors';
import { shouldRetryQuery } from '@/api/queryClient';

import { httpError } from '../helpers/fakeServer';

describe('toApiError', () => {
  it('classifies no response as a network error', () => {
    expect(toApiError(new AxiosError('Network Error', 'ERR_NETWORK')).kind).toBe('network');
  });

  it('classifies an aborted request as a timeout', () => {
    expect(toApiError(new AxiosError('timeout', 'ECONNABORTED')).kind).toBe('timeout');
  });

  it('uses the backend sentence for 4xx errors', () => {
    const error = toApiError(httpError(400, { detail: 'Only 2 seats are left on this departure.' }));
    expect(error).toMatchObject({
      kind: 'validation',
      status: 400,
      message: 'Only 2 seats are left on this departure.',
    });
  });

  it('turns a FastAPI 422 list into one readable sentence', () => {
    const error = toApiError(
      httpError(422, { detail: [{ loc: ['body', 'confirm_password'], msg: 'Value error, Passwords do not match' }] }),
    );
    expect(error.message).toBe('Passwords do not match');
  });

  it('names the field when the 422 message is just "Field required"', () => {
    const error = toApiError(httpError(422, { detail: [{ loc: ['body', 'full_name'], msg: 'Field required' }] }));
    expect(error.message).toBe('Full name is required.');
  });

  it('maps 401, 403 and 404', () => {
    expect(toApiError(httpError(401, { detail: 'Invalid or expired token' })).kind).toBe('unauthorized');
    expect(toApiError(httpError(403, { detail: 'Account is blocked. Please contact support.' }))).toMatchObject({
      kind: 'forbidden',
      message: 'Account is blocked. Please contact support.',
    });
    expect(toApiError(httpError(404, { detail: 'Booking not found.' })).kind).toBe('not_found');
  });

  it('reads Retry-After on a 429', () => {
    const error = toApiError(httpError(429, { detail: 'Too many requests.' }, { 'retry-after': '17' }));
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfter: 17 });
  });

  it('never shows a server error’s body to the customer', () => {
    const error = toApiError(httpError(500, { detail: 'psycopg2.errors.UndefinedTable: relation "x" does not exist' }));
    expect(error.kind).toBe('server');
    expect(error.message).not.toMatch(/psycopg2|relation/);
  });

  it('does not trust an HTML gateway body on a 502', () => {
    const error = toApiError(httpError(502, '<html>Bad gateway</html>'));
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toMatch(/html/i);
  });

  it('passes an ApiError through unchanged and handles non-HTTP failures', () => {
    const original = new ApiError('not_found');
    expect(toApiError(original)).toBe(original);
    expect(toApiError(new Error('boom')).kind).toBe('unknown');
  });
});

describe('retry policy', () => {
  it('marks only transient failures as retryable', () => {
    expect(new ApiError('network').retryable).toBe(true);
    expect(new ApiError('timeout').retryable).toBe(true);
    expect(new ApiError('unavailable').retryable).toBe(true);
    expect(new ApiError('server').retryable).toBe(true);
    expect(new ApiError('validation').retryable).toBe(false);
    expect(new ApiError('unauthorized').retryable).toBe(false);
    expect(new ApiError('not_found').retryable).toBe(false);
    expect(new ApiError('rate_limited').retryable).toBe(false);
  });

  it('retries a failed read at most twice, and never a client error', () => {
    expect(shouldRetryQuery(0, new ApiError('network'))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError('server'))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError('network'))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError('not_found'))).toBe(false);
    expect(shouldRetryQuery(0, new Error('not an ApiError'))).toBe(false);
  });
});
