// Browser history during a PR replay (web/docs/workstation.md「PR 回放」): the camera switches canvas with
// the app's navigation, which pushes an entry each time; here that push is a replace, so the history is
// what it was before the replay. Pure (the history object is passed in).

type Hist = { pushState: History["pushState"]; replaceState: History["replaceState"] };

/** Run `f` with `pushState` doing `replaceState` instead; the original is put back afterwards, whatever `f` does. */
export function replacingPush<T>(f: () => T, h: Hist = history): T {
  const push = h.pushState;
  h.pushState = ((...a: Parameters<History["pushState"]>) => h.replaceState(...a)) as History["pushState"];
  try {
    return f();
  } finally {
    h.pushState = push;
  }
}

/** An address as path + query + hash, without `?replay=`: what a finished replay leaves in the address bar. */
export function withoutReplayParam(href: string): string {
  const u = new URL(href, "http://x");
  u.searchParams.delete("replay");
  return `${u.pathname}${u.search}${u.hash}`;
}
