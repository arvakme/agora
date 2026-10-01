// Loaded into a Pi that Agora starts in a terminal pane (`pi -e`; server/canvas/pane_state.py): tells the Agora
// server when this Pi is idle, running or gone. Pi has no shell hooks, so this does what bin/agora-state does for the others.
const url = process.env.AGORA_URL;
const session = process.env.AGORA_SESSION;

function tell(state: string): void {
  if (!url || !session) return;
  fetch(`${url}/api/agent/sessions/${session}/cli-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {}); // a server that is not there never fails Pi
}

export default function (pi: { on(event: string, handler: () => void): void }) {
  pi.on("session_start", () => tell("idle"));
  pi.on("agent_start", () => tell("running"));
  pi.on("agent_settled", () => tell("idle"));
  pi.on("session_shutdown", () => tell("exited"));
}
