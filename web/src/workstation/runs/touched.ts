// The nodes an agent's canvas changes touched, by canvas (./touch.ts keeps it up to date): places a figure may go to even though no file claims them.
// Its own small module so that geometry.ts (which builds the places) does not depend on the rest of touch.ts. Pure but for the one map.
let byCanvas = new Map<string, Set<string>>();
let version = 0;
export const setTouched = (m: Map<string, Set<string>>) => void ((byCanvas = m), version++);
/** Changes whenever the set does (geometry is built again then, ./Overlay.tsx). */
export const touchedVersion = () => version;
export const touchedNodes = (canvas: string): ReadonlySet<string> => byCanvas.get(canvas) ?? new Set();
export const anyTouched = (canvas: string): boolean => (byCanvas.get(canvas)?.size ?? 0) > 0;
