import { isAxiosError } from 'axios';

export type ApiErrorKind =
  | 'network' // no connection / DNS / refused
  | 'timeout'
  | 'unauthorized' // 401: no valid session
  | 'forbidden' // 403: signed in but not allowed (e.g. blocked account)
  | 'not_found' // 404: also what the backend returns for someone else's booking
  | 'validation' // 400 / 409 / 422: the request itself was refused, with a reason
  | 'rate_limited' // 429
  | 'unavailable' // 502 / 503 / 504: an upstream (supplier, payment provider) is down
  | 'server' // other 5xx
  | 'unknown';

const MESSAGES: Record<Exclude<ApiErrorKind, 'validation'>, string> = {
  network: "Can't reach JackpotsWorld. Check your connection and try again.",
  timeout: 'That took too long. Please try again.',
  unauthorized: 'Please sign in to continue.',
  forbidden: "This account can't do that. Please contact support.",
  not_found: "We couldn't find that.",
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  unavailable: 'This service is temporarily unavailable. Please try again shortly.',
  server: 'Something went wrong on our side. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

/**
 * What the app throws for every failed API call.
 *
 * `message` is always safe to show a customer. For 4xx answers the backend's
 * own `detail` is used, because the customer API writes those sentences for
 * people ("Only 2 seats are left on this departure."). For 5xx it is never
 * used: server errors can carry internals and are not actionable.
 *
 * Nothing here keeps the request or response body, so an error that is
 * logged or sent to a crash reporter cannot leak a passport number or token.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Seconds, when the server sent Retry-After on a 429. */
  readonly retryAfter: number | null;

  constructor(
    kind: ApiErrorKind,
    options: { status?: number | null; message?: string; retryAfter?: number | null } = {},
  ) {
    super(options.message ?? (kind === 'validation' ? MESSAGES.unknown : MESSAGES[kind]));
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }

  /**
   * Whether repeating the identical request could succeed. TanStack Query uses
   * this for GETs only; mutations are never retried automatically, because a
   * retried booking or payment is a duplicate booking or payment.
   */
  get retryable(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'unavailable' ||
      this.kind === 'server'
    );
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** FastAPI 422 items look like `{loc: ["body", "mobile"], msg: "Value error, ..."}`. */
function firstValidationMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail.trim() || null;
  if (Array.isArray(detail) && detail.length > 0) {
    const item = detail[0] as { msg?: unknown; loc?: unknown };
    if (typeof item?.msg === 'string') {
      const msg = item.msg.replace(/^Value error,\s*/i, '').trim();
      // A bare "Field required" is meaningless without the field's name.
      if (/^field required$/i.test(msg) && Array.isArray(item.loc)) {
        const field = String(item.loc[item.loc.length - 1] ?? '').replace(/_/g, ' ');
        return field ? `${field.charAt(0).toUpperCase()}${field.slice(1)} is required.` : msg;
      }
      return msg || null;
    }
  }
  return null;
}

function retryAfterSeconds(headers: unknown): number | null {
  const raw =
    headers && typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (k: string) => unknown }).get('retry-after')
      : (headers as Record<string, unknown> | undefined)?.['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** Normalise anything thrown by an HTTP call into an {@link ApiError}. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (!isAxiosError(error)) return new ApiError('unknown');

  const response = error.response;
  if (!response) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return new ApiError('timeout');
    return new ApiError('network');
  }

  const status = response.status;
  const detail = (response.data as { detail?: unknown } | undefined)?.detail;

  if (status === 401) {
    return new ApiError('unauthorized', {
      status,
      message: typeof detail === 'string' && detail ? detail : undefined,
    });
  }
  if (status === 403) {
    return new ApiError('forbidden', {
      status,
      message: typeof detail === 'string' && detail ? detail : undefined,
    });
  }
  if (status === 404) {
    return new ApiError('not_found', {
      status,
      message: typeof detail === 'string' && detail ? detail : undefined,
    });
  }
  if (status === 429) {
    return new ApiError('rate_limited', {
      status,
      retryAfter: retryAfterSeconds(response.headers),
    });
  }
  if (status === 502 || status === 503 || status === 504) {
    // A 503 from the customer API carries a customer-safe sentence (for
    // example "payments are not available right now"), but a gateway's own 502
    // body is HTML. Only a plain string detail is trusted.
    return new ApiError('unavailable', {
      status,
      message: typeof detail === 'string' && detail ? detail : undefined,
    });
  }
  if (status >= 500) return new ApiError('server', { status });
  if (status >= 400) {
    return new ApiError('validation', {
      status,
      message: firstValidationMessage(detail) ?? MESSAGES.unknown,
    });
  }
  return new ApiError('unknown', { status });
}
