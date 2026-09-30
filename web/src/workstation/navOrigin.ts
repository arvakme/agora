// Who changed the canvas in front. The camera used to guess from how recent a pointer or key was; a browser's back button sends the page neither, and a click
// a moment after the camera's own switch was forgotten by the time the change was seen. Now the places where the person navigates say so as it happens
// (app/App.tsx: `go` — breadcrumbs, back links, keys, popstate — and the tabs), the camera's own navigation says it is its own (`byCamera`), and a canvas
// change that nobody said anything about is the app's (an agent reading a sub-canvas opens it). ./replayView.ts listens.
let seq = 0;
let camera = 0;
const ls = new Set<() => void>();

export const userNav = {
  /** The person navigated (unless the camera is doing it right now: then it is the camera's). */
  note() {
    if (camera) return;
    seq++;
    ls.forEach((l) => l());
  },
  /** How many times the person has navigated; the camera compares it with what it last saw. */
  seq: () => seq,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
};

/** Run the camera's own navigation: whatever it calls, `userNav.note` is not the person's meanwhile. */
export function byCamera<T>(f: () => T): T {
  camera++;
  try {
    return f();
  } finally {
    camera--;
  }
}
