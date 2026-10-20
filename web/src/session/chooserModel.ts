import { tr } from "../i18n";
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

export const NO_LIST_NOTE = tr("没读到模型列表，按 CLI 默认开始", "Couldn't read the model list; starting with the CLI defaults");

export function chooserView(state: CatalogState, o: { hasLevels: boolean } = { hasLevels: true }): ChooserView {
  const def = tr("CLI 默认", "CLI default");
  if (state === "loading") return { model: tr("读取中…", "Loading…"), effort: tr("读取中…", "Loading…"), note: null, retry: false, canStart: false, fields: false };
  if (state === "failed") return { model: def, effort: def, note: NO_LIST_NOTE, retry: true, canStart: true, fields: false };
  return { model: def, effort: o.hasLevels ? def : tr("这个 CLI 不分强度", "No effort levels"), note: null, retry: false, canStart: true, fields: true };
}
