import { useQuery } from '@tanstack/react-query';

import { FLIGHTS_OFF, systemApi, type FlightCapability } from '@/api/endpoints/system';

/**
 * Whether the app may offer Flights. False until the backend positively reports
 * a non-demo supplier, and false while loading or on any error, so a demo
 * fare can never flash on screen.
 */
export function useFlightCapability(): FlightCapability & { isLoading: boolean } {
  const query = useQuery({
    queryKey: ['system', 'flight-capability'],
    queryFn: systemApi.flightCapability,
    // Supplier switches are a deployment event, not a minute-to-minute one.
    staleTime: 10 * 60_000,
  });
  return { ...(query.data ?? FLIGHTS_OFF), isLoading: query.isLoading };
}
