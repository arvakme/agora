// The name a conversation opened from a comment thread should carry ("评论 #2 · 文件与解析"): known when the
// hand-off is sent, used once the session shows up as a workspace doc (app/App.tsx). Not persisted here:
// the doc's own title is, in workspace.json.
const titles = new Map<string, string>();
const listeners = new Set<() => void>();

export const threadSessionTitles = {
  get: (sid: string): string | undefined => titles.get(sid),
  set(sid: string, title: string) {
    if (titles.get(sid) === title) return;
    titles.set(sid, title);
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
};
