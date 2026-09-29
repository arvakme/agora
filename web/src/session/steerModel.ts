// 插话 (ST1): what the page does with words said while an agent works. A CLI that can take them gets them into the
// running turn (`steer`); one that cannot puts the person to a choice — never a silent queue. A terminal pane keeps
// its own rules (input right, busy), so nothing here changes them.
export type SendMode = "auto" | "steer" | "interrupt" | "wait";
export type SendPlan = { kind: "send"; mode: "auto" } | { kind: "steer"; mode: "steer" } | { kind: "choose"; reason: string };

export function planSend(o: { running: boolean; terminalAlive: boolean; steer: boolean | undefined; noSteer: string }): SendPlan {
  if (o.terminalAlive || !o.running) return { kind: "send", mode: "auto" };
  return o.steer === true ? { kind: "steer", mode: "steer" } : { kind: "choose", reason: o.noSteer };
}

export const CHOICES: { mode: "interrupt" | "wait"; label: string }[] = [
  { mode: "interrupt", label: "停下这一轮，改说这句" },
  { mode: "wait", label: "等这一轮做完再说" },
];
export const defaultChoice = (): "interrupt" | "wait" => CHOICES[0].mode;

/** The line under the input for a choice: why this CLI cannot take words in the middle of a turn. */
export const whyNoSteer = (name: string, reason: string): string => `${name} 不能中途插话${reason ? `：${reason}` : ""}`;

export const steerNote = (agent: string, how: "steer" | "interrupt"): string => (how === "steer" ? `已插话给 ${agent}` : `已停下 ${agent} 的这一轮，改说这句`);

/** What words to a session can do: the CLI's ability, except that a session whose last turn fell back to the one-shot way (Codex / Pi
 * without their resident process) cannot take them, and says why (the server's ``steerWhy``). */
export function steerAbility(caps: { steer?: boolean; noSteer?: string }, status?: { steer?: boolean | null; steerWhy?: string | null }): { steer: boolean | undefined; noSteer: string } {
  if (status?.steerWhy) return { steer: false, noSteer: status.steerWhy };
  return { steer: caps.steer, noSteer: caps.noSteer ?? "" };
}
