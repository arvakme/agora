// A loader whose failure is not remembered (session/agents.ts `catalog`): a page that asked while the server was restarting used to keep
// the failure until it was reloaded. Calls in flight share one request; a success is kept; a failure is forgotten, the next call asks again.
export function retryable<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      const mine: Promise<T> = load().catch((e) => {
        if (p === mine) p = null;
        throw e;
      });
      p = mine;
    }
    return p;
  };
}
