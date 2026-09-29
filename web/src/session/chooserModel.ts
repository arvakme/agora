// What the new-session chooser says while its model list loads, when it could not be read, and once it is there (SessionPane.tsx
// `Chooser`). Not being able to read the list must not stop a session from starting: it starts on the CLI's own defaults. Pure.
export type CatalogState = "loading" | "failed" | "ready";

export type ChooserView = {
  /** The model and effort fields' text when they have no value of their own. */
  model: string;
  effort: string;
  /** A line under the fields, and whether it offers 「重试」. */
  note: string | null;
  retry: boolean;
  /** Whether the start button can be pressed (not while the request is out). */
  canStart: boolean;
  /** Whether the two fields can be opened. */
  fields: boolean;
};

export const NO_LIST_NOTE = "没读到模型列表，按 CLI 默认开始";

export function chooserView(state: CatalogState, o: { hasLevels: boolean } = { hasLevels: true }): ChooserView {
  if (state === "loading") return { model: "读取中…", effort: "读取中…", note: null, retry: false, canStart: false, fields: false };
  if (state === "failed") return { model: "CLI 默认", effort: "CLI 默认", note: NO_LIST_NOTE, retry: true, canStart: true, fields: false };
  return { model: "CLI 默认", effort: o.hasLevels ? "CLI 默认" : "这个 CLI 不分强度", note: null, retry: false, canStart: true, fields: true };
}
