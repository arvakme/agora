// The error text of a turn the server stopped for going quiet or running past its fuse (server/canvas/turn_clock.py
// `TurnClock.message`). The native session is intact, so the panel offers 继续: the word goes out as the next message.
export const CONTINUE_WORD = "继续";

const STOPPED = /^这一轮.*，已中止；原生会话还在，发「继续」就能接着$/;

export function stoppedForTime(error: string | null | undefined): boolean {
  return !!error && STOPPED.test(error);
}
