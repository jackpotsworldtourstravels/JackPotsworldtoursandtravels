import type { FlightSearchEnvelope } from '@/types/api';

import { http } from '../client';

export interface FlightCapability {
  enabled: boolean;
  /** What the backend reported, when it reported anything. */
  provider: string | null;
}

/** Fail closed: anything short of a clear "real supplier" answer is "off". */
export const FLIGHTS_OFF: FlightCapability = { enabled: false, provider: null };

/**
 * Decide, from the backend's own answer, whether the app may show Flights.
 *
 * `GET /api/customer/flights/search` with no parameters answers
 * `{provider: "demo", results: []}` while the backend is on its sample
 * supplier. The website's flight results then come from a hard-coded list in
 * the browser, which a store app must never present as live fares. Flights are
 * therefore enabled ONLY when the backend names a supplier that is not "demo".
 *
 * KNOWN LIMITATION, recorded in README.md: with the Duffel adapter active the
 * same parameter-less call is refused with a 400 ("requires from, to and date"),
 * and the probe reads that as "off". Enabling flights for a real supplier will
 * need the backend to expose its provider on a cheap status route; that is a
 * backend change and is deliberately not made here.
 */
export function interpretFlightProbe(body: unknown): FlightCapability {
  if (!body || typeof body !== 'object') return FLIGHTS_OFF;
  const provider = (body as Partial<FlightSearchEnvelope>).provider;
  if (typeof provider !== 'string' || provider.trim() === '') return FLIGHTS_OFF;
  const name = provider.trim().toLowerCase();
  if (name === 'demo') return { enabled: false, provider: name };
  return { enabled: true, provider: name };
}

export const systemApi = {
  /** `GET /api/health` -> `{status: "ok"}`. Unauthenticated. */
  async health(): Promise<boolean> {
    const { data } = await http.get<{ status?: string }>('/api/health', { skipAuth: true });
    return data?.status === 'ok';
  },

  async flightCapability(): Promise<FlightCapability> {
    try {
      const { data } = await http.get<unknown>('/api/customer/flights/search', { skipAuth: true });
      return interpretFlightProbe(data);
    } catch {
      return FLIGHTS_OFF;
    }
  },
};
