// While a turn plays, the right side shows only that turn (the others fold); the person's own folding comes back when it
// ends because it is never overwritten — this only says what to draw. Pure.
export const turnOpen = (n: number, playing: number | null, folded: ReadonlySet<number>): boolean => (playing != null ? n === playing : !folded.has(n));
