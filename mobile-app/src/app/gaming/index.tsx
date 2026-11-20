import { Redirect } from 'expo-router';

/**
 * GAMING TOUR PACKAGES — DISABLED (Stage 1 fail-closed).
 *
 * Gaming is turned off until explicitly authorized. Its navigation entries are
 * removed (the header drawer, the footer and the home search tabs), and this
 * route — the only way to reach the enquiry form — redirects to Home, so direct
 * navigation to `/gaming` cannot open the form and no enquiry can be submitted
 * from the app. The public enquiry API itself also returns 404 (backend
 * fail-closed), so a submission could not succeed even if the form were reached.
 *
 * The form logic and copy modules (`@/features/gaming/*`) are intentionally
 * left in place so re-enabling Gaming is a single change here.
 */
export default function GamingScreen() {
  return <Redirect href="/" />;
}
