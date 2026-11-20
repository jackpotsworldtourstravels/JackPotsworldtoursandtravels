import { Redirect } from 'expo-router';

import GamingScreen from '@/app/gaming/index';

/**
 * Gaming Tour Packages is DISABLED (Stage 1 fail-closed). The `/gaming` route no
 * longer renders the enquiry form — it returns only a Redirect to Home — so
 * direct navigation cannot reach the form and no enquiry can be submitted from
 * the app. (The public enquiry API also returns 404, so a submission could not
 * succeed regardless.) Asserted structurally, without rendering, so the test
 * does not depend on the router/navigation test harness.
 */
describe('the Gaming Tour Packages route — disabled (Stage 1 fail-closed)', () => {
  it('renders only a Redirect to Home — no enquiry form, nothing to submit', () => {
    const element = GamingScreen() as { type: unknown; props: { href?: string } };
    expect(element.type).toBe(Redirect);
    expect(element.props.href).toBe('/');
  });
});
