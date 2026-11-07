type Listener = () => void;

const expiredListeners = new Set<Listener>();

/**
 * How the HTTP layer tells the rest of the app that the customer's session is
 * gone for good (refresh token rejected), without the HTTP layer importing React
 * or navigation. AuthProvider subscribes and moves the app to signed-out.
 */
export const sessionEvents = {
  onExpired(listener: Listener): () => void {
    expiredListeners.add(listener);
    return () => {
      expiredListeners.delete(listener);
    };
  },
  emitExpired(): void {
    for (const listener of [...expiredListeners]) listener();
  },
};
