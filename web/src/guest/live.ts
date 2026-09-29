// The guest page's live channel. Normally an SSE stream; some tunnels (Cloudflare's account-less
// quick tunnels) buffer a stream until it ends, so nothing arrives. The gateway sends `hello`
// first: if it has not shown up in time, drop the stream and poll instead (web/docs/sharing.md §10).

export type LiveEvent = { t: string; canvasId?: string; data?: unknown; elements?: unknown };
type Source = { onmessage: ((e: { data: string }) => void) | null; close(): void };

export const HELLO_MS = 5000;
export const POLL_MS = 4000;

export function openLive(opts: {
  onEvent: (ev: LiveEvent) => void;
  poll: () => Promise<void>;
  open?: (url: string) => Source;
  helloMs?: number;
  pollMs?: number;
}): () => void {
  const open = opts.open ?? ((url) => new EventSource(url) as Source);
  let timer: ReturnType<typeof setInterval> | undefined;
  const es = open("/api/guest/events");
  const giveUp = setTimeout(() => {
    es.close();
    timer = setInterval(() => void opts.poll().catch(() => {}), opts.pollMs ?? POLL_MS);
  }, opts.helloMs ?? HELLO_MS);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data) as LiveEvent;
    if (ev.t === "hello") clearTimeout(giveUp);
    else opts.onEvent(ev);
  };
  return () => {
    clearTimeout(giveUp);
    if (timer) clearInterval(timer);
    es.close();
  };
}
