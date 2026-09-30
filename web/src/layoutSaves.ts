// The way from a played turn (workstation/replayMode.ts) to the project's layout saving (persist.ts) without
// either importing the other: persist.ts registers what pauses the workspace layout's saves; the play
// pauses them when it starts and resumes them once the canvas and view it was entered from are back.
let handler: ((on: boolean) => void) | null = null;
export const layoutSaves = {
  register: (h: (on: boolean) => void) => void (handler = h),
  pause: (on: boolean) => handler?.(on),
};
