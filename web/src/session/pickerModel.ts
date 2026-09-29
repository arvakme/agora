// The model / effort picker's logic, kept free of React so it can be tested directly:
// which options exist and how they group (from the server's catalog), fuzzy filtering,
// the visible rows, and keyboard movement. Picker.tsx renders it.
import type { CatalogEntry } from "./agents";

export type PickOption = { value: string; label: string; detail?: string; note?: string };
export type PickGroup = { id: string; label: string; options: PickOption[] };
export type PickRow =
  | { kind: "header"; group: string; label: string; count: number; open: boolean; collapsible: boolean }
  | { kind: "option"; group: string; option: PickOption };

/** At most this many options: a plain list. More: a search box and folded provider groups. */
export const SEARCH_THRESHOLD = 8;

export const optionCount = (groups: PickGroup[]) => groups.reduce((n, g) => n + g.options.length, 0);
export const isSearchable = (groups: PickGroup[], threshold = SEARCH_THRESHOLD) => optionCount(groups) > threshold;
export const findOption = (groups: PickGroup[], value: string) => groups.flatMap((g) => g.options).find((o) => o.value === value);

/**
 * The model picker's groups for one agent: the enabled / featured models first, then the rest
 * by provider (Pi) or as one "其他模型" group. A model shows its friendly name with the full id
 * as secondary text; "" (no --model) is offered when the CLI has no known default.
 */
export function modelGroups(entry: CatalogEntry | undefined): PickGroup[] {
  if (!entry) return [];
  const names = entry.names ?? {};
  const providers = entry.providers ?? {};
  const opt = (m: string): PickOption => {
    const label = names[m] || m;
    return { value: m, label, detail: label !== m ? m : undefined, note: m === entry.default ? "默认" : undefined };
  };
  const featured = entry.featured.filter((m) => entry.models.includes(m) || m === entry.default);
  const first: PickOption[] = [...(entry.default ? [] : [{ value: "", label: "CLI 默认", detail: "不指定模型，用 CLI 自己的默认" }]), ...featured.map(opt)];
  const groups: PickGroup[] = [];
  if (first.length) groups.push({ id: "featured", label: entry.scope?.kind === "enabledModels" ? "已启用" : "常用", options: first });
  const rest = new Map<string, string[]>();
  for (const m of entry.models) {
    if (featured.includes(m)) continue;
    const p = providers[m] ?? "";
    rest.set(p, [...(rest.get(p) ?? []), m]);
  }
  for (const [p, ms] of rest) groups.push({ id: `p:${p}`, label: p || "其他模型", options: ms.map(opt) });
  return groups;
}

/** The effort picker's one group: the levels this model takes, "CLI 默认" when Agora knows no default. */
export function effortGroups(eff: { levels: string[]; initial: string; cliDefault: boolean }): PickGroup[] {
  const options: PickOption[] = [];
  if (eff.cliDefault || !eff.levels.length) options.push({ value: "", label: eff.levels.length ? "CLI 默认" : "这个 CLI 不分强度", detail: eff.levels.length ? "不传强度参数" : "没有强度可选，不传强度参数" });
  for (const x of eff.levels) options.push({ value: x, label: x, note: x === eff.initial ? "默认" : undefined });
  return [{ id: "effort", label: "强度", options }];
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");

/**
 * How well `query` matches an option (null = no match). Every whitespace-separated token must
 * match the full id or the name: as a substring (better at the start or after a separator), else
 * ignoring separators ("opus55" → "opus-5-5"), else (4+ characters) as a subsequence ("gsol" → "gpt-6-sol").
 */
export function fuzzyScore(query: string, option: PickOption): number | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const hay = `${option.detail ?? option.value} ${option.label}`.toLowerCase();
  const flat = compact(hay);
  let score = 0;
  for (const t of tokens) {
    const i = hay.indexOf(t);
    if (i >= 0) {
      score += 100 - Math.min(i, 40) + (i === 0 || /[^a-z0-9]/.test(hay[i - 1]) ? 20 : 0);
      continue;
    }
    const ct = compact(t);
    if (!ct) continue;
    if (flat.includes(ct)) {
      score += 60;
      continue;
    }
    if (ct.length < 4) return null; // short tokens as subsequences match almost anything
    let j = 0;
    let gaps = 0;
    for (let k = 0; k < flat.length && j < ct.length; k++) {
      if (flat[k] === ct[j]) j++;
      else if (j > 0) gaps++;
    }
    if (j < ct.length) return null;
    score += Math.max(1, 30 - gaps);
  }
  return score;
}

/**
 * The rows the list shows. No query: groups with headers (when there is more than one group);
 * in a searchable list only the first group and the one holding `selected` start open, the
 * others fold. With a query: only matching options, best first within each group, all open.
 */
export function pickerRows(groups: PickGroup[], query: string, open: Record<string, boolean>, selected?: string, threshold = SEARCH_THRESHOLD): PickRow[] {
  const searchable = isSearchable(groups, threshold);
  const headers = groups.length > 1;
  const rows: PickRow[] = [];
  const q = query.trim();
  groups.forEach((g, gi) => {
    if (q) {
      const hits = g.options
        .map((o, i) => ({ o, i, s: fuzzyScore(q, o) }))
        .filter((x): x is { o: PickOption; i: number; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || a.i - b.i);
      if (!hits.length) return;
      if (headers) rows.push({ kind: "header", group: g.id, label: g.label, count: hits.length, open: true, collapsible: false });
      for (const h of hits) rows.push({ kind: "option", group: g.id, option: h.o });
      return;
    }
    const collapsible = searchable && headers && gi > 0;
    const isOpen = !collapsible || (open[g.id] ?? g.options.some((o) => o.value === selected));
    if (headers) rows.push({ kind: "header", group: g.id, label: g.label, count: g.options.length, open: isOpen, collapsible });
    if (isOpen) for (const o of g.options) rows.push({ kind: "option", group: g.id, option: o });
  });
  return rows;
}

/** Rows the keyboard can land on: options, and headers that fold. */
export const focusable = (r: PickRow) => r.kind === "option" || r.collapsible;

/** ↑ / ↓ / Home / End from `active` (-1 = nothing yet); stops at the ends. */
export function moveActive(rows: PickRow[], active: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  const idx = rows.map((r, i) => (focusable(r) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return -1;
  if (key === "Home") return idx[0];
  if (key === "End") return idx[idx.length - 1];
  const pos = idx.indexOf(active);
  if (pos < 0) return key === "ArrowDown" ? idx[0] : idx[idx.length - 1];
  return key === "ArrowDown" ? idx[Math.min(pos + 1, idx.length - 1)] : idx[Math.max(pos - 1, 0)];
}

/** Where the highlight starts when the list opens or the query changes: the selected option if visible, else the first option. */
export function initialActive(rows: PickRow[], selected: string | undefined, query: string): number {
  if (!query.trim()) {
    const i = rows.findIndex((r) => r.kind === "option" && r.option.value === selected);
    if (i >= 0) return i;
  }
  return rows.findIndex((r) => r.kind === "option");
}

export type PickState = { open: boolean; query: string; active: number; folds: Record<string, boolean> };
export const closedState = (): PickState => ({ open: false, query: "", active: -1, folds: {} });

/** Open the list on the selected option. */
export function openState(groups: PickGroup[], selected: string, prev: PickState = closedState()): PickState {
  const s = { ...prev, open: true, query: "" };
  return { ...s, active: initialActive(pickerRows(groups, "", s.folds, selected), selected, "") };
}

/** A new query: the highlight goes to the best match. */
export function queryState(groups: PickGroup[], state: PickState, query: string, selected: string): PickState {
  return { ...state, query, active: initialActive(pickerRows(groups, query, state.folds, selected), selected, query) };
}

/** Fold or unfold a group; the highlight stays on its header. */
export function toggleGroup(groups: PickGroup[], state: PickState, group: string, selected: string, want?: boolean): PickState {
  const cur = pickerRows(groups, state.query, state.folds, selected).find((r) => r.kind === "header" && r.group === group);
  if (!cur || cur.kind !== "header" || !cur.collapsible) return state;
  const folds = { ...state.folds, [group]: want ?? !cur.open };
  const rows = pickerRows(groups, state.query, folds, selected);
  return { ...state, folds, active: rows.findIndex((r) => r.kind === "header" && r.group === group) };
}

/**
 * One key press while the list is open. Returns the next state, the value to commit (Enter on
 * an option) and whether the key was handled (so the component can preventDefault).
 */
export function pickerKey(groups: PickGroup[], state: PickState, key: string, selected: string): { state: PickState; pick?: string; handled: boolean } {
  if (!state.open) {
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") return { state: openState(groups, selected, state), handled: true };
    return { state, handled: false };
  }
  const rows = pickerRows(groups, state.query, state.folds, selected);
  const row = rows[state.active];
  switch (key) {
    case "ArrowDown":
    case "ArrowUp":
    case "Home":
    case "End":
      return { state: { ...state, active: moveActive(rows, state.active, key) }, handled: true };
    case "Escape":
      return { state: { ...closedState(), folds: state.folds }, handled: true };
    case "Tab":
      return { state: { ...closedState(), folds: state.folds }, handled: false };
    case "Enter":
      if (row?.kind === "option") return { state: { ...closedState(), folds: state.folds }, pick: row.option.value, handled: true };
      if (row?.kind === "header") return { state: toggleGroup(groups, state, row.group, selected), handled: true };
      return { state, handled: true };
    case "ArrowRight":
    case "ArrowLeft":
      if (row?.kind === "header" && row.collapsible) return { state: toggleGroup(groups, state, row.group, selected, key === "ArrowRight"), handled: true };
      return { state, handled: false };
    default:
      return { state, handled: false };
  }
}
