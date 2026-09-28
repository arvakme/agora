import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "./agents";
import { closedState, effortGroups, fuzzyScore, isSearchable, modelGroups, openState, pickerKey, pickerRows, queryState, type PickGroup, type PickState } from "./pickerModel";

const MAGPIE = ["magpie/group/opus-5-5", "magpie/group/fable-5-1", "magpie/group/gpt-6-sol", "magpie/group/gpt-6-astra"];
const base = { installed: true, efforts: [], defaultEffort: "" };

const piScoped: CatalogEntry = {
  ...base,
  kind: "pi",
  name: "Pi",
  default: MAGPIE[0],
  models: MAGPIE,
  featured: MAGPIE,
  names: { [MAGPIE[0]]: "Opus 5.5 · routing group", [MAGPIE[2]]: "GPT-6 Sol · routing group" },
  providers: Object.fromEntries(MAGPIE.map((m) => [m, "magpie"])),
  scope: { kind: "enabledModels", source: "~/.pi/agent/settings.json" },
};

const or = ["openrouter/openai/gpt-5", "openrouter/openai/gpt-5-pro", "openrouter/anthropic/claude-opus-4.6", "openrouter/moonshotai/kimi-k2.6", "openrouter/x-ai/grok-4.7"];
const ds = ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"];
const piWide: CatalogEntry = {
  ...base,
  kind: "pi",
  name: "Pi",
  default: MAGPIE[0],
  models: [...MAGPIE, ...or, ...ds],
  featured: [MAGPIE[0]],
  names: { "openrouter/openai/gpt-5-pro": "OpenAI: GPT-5 Pro", "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro" },
  providers: Object.fromEntries([...MAGPIE.map((m) => [m, "magpie"]), ...or.map((m) => [m, "openrouter"]), ...ds.map((m) => [m, "deepseek"])]),
  scope: { kind: "available" },
};

const values = (g: PickGroup[]) => g.map((x) => [x.label, x.options.map((o) => o.value)]);
const shown = (rows: ReturnType<typeof pickerRows>) => rows.map((r) => (r.kind === "header" ? `# ${r.label}${r.open ? "" : " +"}` : r.option.value));

describe("model picker groups", () => {
  it("Pi with enabledModels: one plain list of exactly the enabled models, friendly names first", () => {
    const g = modelGroups(piScoped);
    expect(values(g)).toEqual([["已启用", MAGPIE]]);
    expect(isSearchable(g)).toBe(false);
    expect(g[0].options[0]).toEqual({ value: MAGPIE[0], label: "Opus 5.5 · routing group", detail: MAGPIE[0], note: "默认" });
    expect(g[0].options[1]).toEqual({ value: MAGPIE[1], label: MAGPIE[1], detail: undefined, note: undefined }); // no name: the id alone
    // a plain list has no headers
    expect(shown(pickerRows(g, "", {}, MAGPIE[0]))).toEqual(MAGPIE);
  });

  it("many models: featured first, the rest by provider and folded (the selected one's group stays open)", () => {
    const g = modelGroups(piWide);
    expect(g.map((x) => x.label)).toEqual(["常用", "magpie", "openrouter", "deepseek"]);
    expect(isSearchable(g)).toBe(true);
    expect(shown(pickerRows(g, "", {}, MAGPIE[0]))).toEqual(["# 常用", MAGPIE[0], "# magpie +", "# openrouter +", "# deepseek +"]);
    expect(shown(pickerRows(g, "", {}, "deepseek/deepseek-flash")).slice(-3)).toEqual(["# deepseek", "deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
    expect(shown(pickerRows(g, "", { "p:openrouter": true }, MAGPIE[0]))).toContain("openrouter/x-ai/grok-4.7");
  });

  it("no known default: a CLI 默认 choice first; Claude / Codex without providers get one 其他模型 group", () => {
    const claude: CatalogEntry = { ...base, kind: "claude", name: "Claude Code", default: "", models: ["opus", "sonnet", "haiku", "claude-opus-4-6"], featured: ["opus", "sonnet", "haiku"], names: { opus: "Opus 5.5" } };
    const g = modelGroups(claude);
    expect(values(g)).toEqual([["常用", ["", "opus", "sonnet", "haiku"]], ["其他模型", ["claude-opus-4-6"]]]);
    expect(g[0].options[0].label).toBe("CLI 默认");
  });

  it("effort: the model's levels, its default marked, CLI 默认 only when no default is known", () => {
    expect(effortGroups({ levels: ["low", "high"], initial: "high", cliDefault: false })[0].options.map((o) => [o.value, o.note])).toEqual([["low", undefined], ["high", "默认"]]);
    expect(effortGroups({ levels: ["low"], initial: "", cliDefault: true })[0].options.map((o) => o.label)).toEqual(["CLI 默认", "low"]);
    expect(effortGroups({ levels: [], initial: "", cliDefault: true })[0].options.map((o) => o.label)).toEqual(["不支持"]);
  });
});

describe("fuzzy filter", () => {
  const g = modelGroups(piWide);
  it("matches provider/id and the friendly name, token by token", () => {
    expect(shown(pickerRows(g, "gpt-5 pro", {}, ""))).toEqual(["# openrouter", "openrouter/openai/gpt-5-pro"]);
    expect(shown(pickerRows(g, "deepseek", {}, ""))).toEqual(["# deepseek", "deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
    expect(shown(pickerRows(g, "DeepSeek V4", {}, ""))).toEqual(["# deepseek", "deepseek/deepseek-v4-pro"]);
    expect(shown(pickerRows(g, "openrouter kimi", {}, ""))).toEqual(["# openrouter", "openrouter/moonshotai/kimi-k2.6"]);
  });
  it("ignores separators and accepts subsequences; ranks prefix and substring matches first", () => {
    expect(fuzzyScore("opus55", { value: MAGPIE[0], label: MAGPIE[0] })).not.toBeNull();
    expect(fuzzyScore("gsol", { value: MAGPIE[2], label: MAGPIE[2] })).not.toBeNull();
    expect(fuzzyScore("zzz", { value: MAGPIE[2], label: MAGPIE[2] })).toBeNull();
    const rows = shown(pickerRows(g, "gpt", {}, ""));
    expect(rows.indexOf("magpie/group/gpt-6-sol")).toBeGreaterThan(-1);
    expect(rows).not.toContain("deepseek/deepseek-flash");
    // a query opens every group that has a hit, even folded ones
    expect(shown(pickerRows(g, "grok", { "p:openrouter": false }, ""))).toEqual(["# openrouter", "openrouter/x-ai/grok-4.7"]);
    expect(pickerRows(g, "no-such-model", {}, "")).toEqual([]);
  });
});

describe("keyboard", () => {
  const g = modelGroups(piWide);
  const press = (s: PickState, ...keys: string[]) => {
    let pick: string | undefined;
    for (const k of keys) {
      const r = pickerKey(g, s, k, MAGPIE[0]);
      s = r.state;
      pick = r.pick ?? pick;
    }
    return { s, pick, rows: pickerRows(g, s.query, s.folds, MAGPIE[0]) };
  };

  it("↓ opens on the selected option; ↑↓ move; Enter picks and closes", () => {
    const { s } = press(closedState(), "ArrowDown");
    expect(s.open).toBe(true);
    const r = pickerRows(g, "", s.folds, MAGPIE[0])[s.active];
    expect(r.kind === "option" && r.option.value).toBe(MAGPIE[0]);
    // ↓ lands on the first folded header; Enter unfolds it, ↓ goes into it, Enter picks
    const out = press(s, "ArrowDown", "Enter", "ArrowDown", "Enter");
    expect(out.pick).toBe(MAGPIE[1]);
    expect(out.s.open).toBe(false);
    expect(out.s.folds["p:magpie"]).toBe(true); // the unfold is remembered
  });

  it("→ / ← unfold and fold a group header; Home / End jump", () => {
    const o = openState(g, MAGPIE[0]);
    const onHeader = press(o, "ArrowDown");
    expect(onHeader.rows[onHeader.s.active]).toMatchObject({ kind: "header", group: "p:magpie", open: false });
    const opened = press(onHeader.s, "ArrowRight");
    expect(opened.rows[opened.s.active]).toMatchObject({ kind: "header", group: "p:magpie", open: true });
    expect(press(opened.s, "ArrowLeft").rows.some((r) => r.kind === "option" && r.option.value === MAGPIE[1])).toBe(false);
    const end = press(o, "End");
    expect(end.rows[end.s.active]).toMatchObject({ kind: "header", group: "p:deepseek" });
    const home = press(end.s, "Home");
    expect(home.s.active).toBe(1); // first focusable row: the 常用 option under its header
  });

  it("typing moves the highlight to the best match; Enter picks it; Esc closes without picking", () => {
    const typed = queryState(g, openState(g, MAGPIE[0]), "grok", MAGPIE[0]);
    const r = pickerKey(g, typed, "Enter", MAGPIE[0]);
    expect(r.pick).toBe("openrouter/x-ai/grok-4.7");
    expect(r.state.open).toBe(false);
    const esc = pickerKey(g, typed, "Escape", MAGPIE[0]);
    expect(esc.pick).toBeUndefined();
    expect(esc.state.open).toBe(false);
    expect(esc.handled).toBe(true);
    // ↓ past the end stays on the last row
    const one = press(typed, "ArrowDown", "ArrowDown");
    expect(one.rows[one.s.active]).toMatchObject({ kind: "option", option: { value: "openrouter/x-ai/grok-4.7" } });
  });
});
