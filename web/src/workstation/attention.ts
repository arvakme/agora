// The person came back to the page (web/docs/workstation.md「新想法」, 等你就叫你): the figures waiting on
// them turn and wave. Pinged by ./WaitNotifier.tsx when the page is in view again; `at` is wall-clock
// ms, null until the first time.

export type Attention = { at: number } | null;
let state: Attention = null;
const ls = new Set<() => void>();

export const attention = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  ping() {
    state = { at: Date.now() };
    ls.forEach((l) => l());
  },
};
