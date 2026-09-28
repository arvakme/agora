// One picker for every agent's model and effort: a button that opens a list. Up to
// SEARCH_THRESHOLD options it is a plain list; above that it gets a search box (fuzzy over
// name and full id) and the non-featured groups fold. ↑↓ / Home / End move, Enter picks or
// folds a group, ←→ fold / unfold, Esc closes. Logic lives in pickerModel.ts.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCheck, IconChevron, IconSearch } from "../app/icons";
import { SPRING } from "../comments/motion";
import { closedState, findOption, isSearchable, optionCount, openState, pickerKey, pickerRows, queryState, toggleGroup, type PickGroup, type PickState } from "./pickerModel";

export function Picker({ label, value, onChange, groups, disabled, placeholder, title, compact }: { label: string; value: string; onChange: (v: string) => void; groups: PickGroup[]; disabled?: boolean; placeholder?: string; title?: string; /** Trigger shows the label only (narrow fields). */ compact?: boolean }) {
  const id = useId();
  const [st, setSt] = useState<PickState>(closedState);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchable = isSearchable(groups);
  const rows = useMemo(() => (st.open ? pickerRows(groups, st.query, st.folds, value) : []), [groups, st.open, st.query, st.folds, value]);
  const current = findOption(groups, value);
  // Open downward unless the space below is short and there is more above; the list fits either way.
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: false, max: 320 });
  const measure = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const chrome = searchable ? 48 : 12;
    const rowsTall = (optionCount(groups) + (groups.length > 1 ? groups.length : 0)) * 32;
    const up = Math.min(320, rowsTall) + chrome > below && above > below;
    setPlace({ up, max: Math.max(120, Math.min(320, (up ? above : below) - chrome)) });
  };

  useEffect(() => {
    if (!st.open) return;
    (searchable ? search.current : list.current)?.focus();
  }, [st.open, searchable]);
  useEffect(() => {
    if (st.active >= 0) list.current?.querySelector(`[data-row="${st.active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [st.active, st.open]);

  const close = (focus = true) => {
    setSt((s) => ({ ...closedState(), folds: s.folds }));
    if (focus) trigger.current?.focus();
  };
  const pick = (v: string) => {
    onChange(v);
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const r = pickerKey(groups, st, e.key, value);
    if (!r.handled && e.key !== "Tab") return;
    if (r.handled) e.preventDefault();
    const wasOpen = st.open;
    setSt(r.state);
    if (r.pick !== undefined) onChange(r.pick);
    if (wasOpen && !r.state.open && e.key !== "Tab") trigger.current?.focus();
  };
  const optId = (i: number) => `${id}-r${i}`;

  return (
    <div className="pk" data-open={st.open} data-compact={!!compact}>
      <span className="pk-label" id={`${id}-l`}>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="pk-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={st.open}
        aria-controls={`${id}-list`}
        aria-label={label}
        disabled={disabled}
        title={title ?? current?.detail ?? current?.label}
        onClick={() => (st.open ? close() : (measure(), setSt(openState(groups, value, st))))}
        onKeyDown={(e) => (st.open || measure(), onKey(e))}
      >
        <span className="pk-value">
          <span className="pk-name">{current?.label ?? (value || "CLI 默认")}</span>
          {current?.detail && !compact && <span className="pk-id">{current.detail}</span>}
        </span>
        <IconChevron size={12} open={st.open} />
      </button>
      <AnimatePresence>
        {st.open && (
          <motion.div
            className="menu pk-pop"
            data-up={place.up}
            style={{ "--pk-max": `${place.max}px` } as React.CSSProperties}
            initial={{ opacity: 0, y: place.up ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }}
            transition={SPRING}
          >
            {searchable && (
              <div className="pk-search">
                <IconSearch size={14} />
                <input
                  ref={search}
                  role="combobox"
                  aria-expanded
                  aria-controls={`${id}-list`}
                  aria-autocomplete="list"
                  aria-activedescendant={st.active >= 0 ? optId(st.active) : undefined}
                  aria-label={`搜索${label}`}
                  placeholder={placeholder ?? "搜索"}
                  value={st.query}
                  onChange={(e) => setSt(queryState(groups, st, e.target.value, value))}
                  onKeyDown={onKey}
                />
              </div>
            )}
            <div
              ref={list}
              id={`${id}-list`}
              className="pk-list"
              role="listbox"
              aria-label={label}
              tabIndex={searchable ? undefined : -1}
              aria-activedescendant={!searchable && st.active >= 0 ? optId(st.active) : undefined}
              onKeyDown={searchable ? undefined : onKey}
            >
              {rows.length === 0 && <p className="pk-empty">没有匹配「{st.query}」的{label}</p>}
              {rows.map((r, i) =>
                r.kind === "header" ? (
                  r.collapsible ? (
                    <button
                      key={`h-${r.group}`}
                      id={optId(i)}
                      data-row={i}
                      type="button"
                      tabIndex={-1}
                      className="pk-group"
                      data-active={st.active === i}
                      aria-expanded={r.open}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => setSt(toggleGroup(groups, st, r.group, value))}
                    >
                      <IconChevron size={10} open={r.open} />
                      <span>{r.label}</span>
                      <em>{r.count}</em>
                    </button>
                  ) : (
                    <p key={`h-${r.group}`} className="pk-group" data-static role="presentation">
                      <span>{r.label}</span>
                      <em>{r.count}</em>
                    </p>
                  )
                ) : (
                  <div
                    key={`o-${r.group}-${r.option.value}`}
                    id={optId(i)}
                    data-row={i}
                    role="option"
                    aria-selected={r.option.value === value}
                    className="pk-opt"
                    data-active={st.active === i}
                    data-on={r.option.value === value}
                    onPointerDown={(e) => e.preventDefault()}
                    onPointerMove={() => st.active !== i && setSt((s) => ({ ...s, active: i }))}
                    onClick={() => pick(r.option.value)}
                    title={r.option.detail}
                  >
                    <span className="menu-check">{r.option.value === value && <IconCheck size={14} />}</span>
                    <span className="pk-value">
                      <span className="pk-name">{r.option.label}</span>
                      {r.option.detail && <span className="pk-id">{r.option.detail}</span>}
                    </span>
                    {r.option.note && <em className="menu-note">{r.option.note}</em>}
                  </div>
                ),
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {st.open && <div className="menu-scrim pk-scrim" onPointerDown={() => close(false)} />}
    </div>
  );
}
