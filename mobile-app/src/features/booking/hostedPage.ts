import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';

import { colors } from '@/theme';

/**
 * Showing the provider's hosted payment page, and knowing when the customer is back.
 *
 * `expo-web-browser` behaves differently by platform. On iOS `openBrowserAsync`
 * resolves when the customer closes the page. On ANDROID it resolves as soon as
 * the page has opened, long before they have paid. If the app asked the backend
 * the moment that promise resolved, it would poll for about a minute while the
 * customer was still entering their details, give up, and never look again when
 * they returned. So on Android we also wait for the app to leave the foreground
 * and come back.
 *
 * Nothing here decides anything about the payment. It only says "the customer
 * is back; now ask the backend".
 */
export const RETURN_WAIT_MS = 20 * 60_000;

export interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * Resolves once the app has gone to the background and come back to the
 * foreground, or after `timeoutMs` (so an abandoned wait still ends and the
 * caller can ask the backend once). Create it BEFORE opening the browser: the app
 * can be backgrounded within milliseconds.
 */
export function returnWaiter(appState: AppStateLike, timeoutMs: number = RETURN_WAIT_MS) {
  let left = appState.currentState !== 'active';
  let done = false;
  let finish: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    finish = () => {
      if (done) return;
      done = true;
      subscription.remove();
      clearTimeout(timer);
      resolve();
    };
  });
  const subscription = appState.addEventListener('change', (state) => {
    if (state !== 'active') left = true;
    else if (left) finish();
  });
  const timer = setTimeout(finish, timeoutMs);
  return { wait, cancel: finish };
}

/** Open the hosted page and resolve when the customer is back in the app. Rejects only if the page could not be opened. */
export async function openHostedPage(
  url: string,
  platform: string = Platform.OS,
  appState: AppStateLike = AppState as unknown as AppStateLike,
): Promise<void> {
  const waiter = platform === 'android' ? returnWaiter(appState) : null;
  try {
    const result = await WebBrowser.openBrowserAsync(url, {
      toolbarColor: colors.navy900,
      controlsColor: colors.white,
      dismissButtonStyle: 'close',
      showTitle: true,
    });
    if (waiter && result.type === 'opened') await waiter.wait;
  } finally {
    waiter?.cancel();
  }
}
