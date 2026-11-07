import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
  skipAuth: boolean;
}

export type FakeReply =
  | { status: number; data?: unknown; headers?: Record<string, string> }
  | 'network'
  | 'timeout';

export type FakeHandler = (req: RecordedRequest) => FakeReply | Promise<FakeReply>;

/**
 * A network transport for axios that answers from a function and records every
 * request, so tests can assert exactly what the app sent and how often.
 * Non-2xx replies reject with a real AxiosError, as the real adapter does.
 */
export function fakeAdapter(handler: FakeHandler): { adapter: AxiosAdapter; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const headers = AxiosHeaders.from(config.headers);
    const raw = config.data;
    const record: RecordedRequest = {
      method: (config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      authorization: (headers.get('Authorization') as string | undefined) ?? null,
      body: typeof raw === 'string' ? JSON.parse(raw) : (raw ?? null),
      skipAuth: Boolean(config.skipAuth),
    };
    requests.push(record);

    const reply = await handler(record);
    if (reply === 'network') throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    if (reply === 'timeout') throw new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config);

    const response: AxiosResponse = {
      status: reply.status,
      statusText: String(reply.status),
      data: reply.data ?? null,
      headers: reply.headers ?? {},
      config,
    };
    if (reply.status >= 200 && reply.status < 300) return response;
    throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, undefined, response);
  };

  return { adapter, requests };
}

/** An AxiosError for a given status, for testing error normalisation directly. */
export function httpError(status: number, data?: unknown, headers: Record<string, string> = {}): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  const response: AxiosResponse = { status, statusText: String(status), data, headers, config };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
}
