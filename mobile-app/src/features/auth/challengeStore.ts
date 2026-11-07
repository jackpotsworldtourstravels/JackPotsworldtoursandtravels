import type { LoginChallenge } from '@/types/api';

/**
 * The sign-in challenge handed from "enter your details" to "enter the code".
 *
 * Held in memory only. The challenge token is useless without the emailed
 * code, but it is still a credential-in-progress, so it is not put in route
 * params (which end up in deep-link state and, on web, the URL) and never
 * written to storage. Killing the app abandons the attempt, which is the right
 * outcome for a half-finished sign-in.
 */
let current: { challenge: LoginChallenge; identifier: string } | null = null;

export const challengeStore = {
  set(challenge: LoginChallenge, identifier: string): void {
    current = { challenge, identifier };
  },
  get(): { challenge: LoginChallenge; identifier: string } | null {
    return current;
  },
  update(challenge: LoginChallenge): void {
    if (current) current = { ...current, challenge };
  },
  clear(): void {
    current = null;
  },
};
