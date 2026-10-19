// What the session menu says about the terminal's windows: whether anyone is actually connected to the pane (Agora runs the CLI in its own tmux pane; a window is just
// somebody attached to it, so "opened" and "connected" are different things the person needs told apart).
import type { Status } from "./agents";

export function windowsLine(t: Pick<Status["terminal"], "alive" | "clients" | "writers" | "inputRight">): string {
  if (!t.alive) return "终端没有开着";
  if (!t.clients) return "终端开着，还没有窗口连上";
  const paused = t.writers ? "有可写窗口，自动投递暂停" : t.inputRight === "human" ? "已接管，自动投递暂停" : "";
  return `${t.clients} 个窗口连着${paused ? `（${paused}）` : ""}`;
}

/** Whether the text reached the clipboard: a page the browser does not trust (plain http) or a refused permission has none, and the person has to be told. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
