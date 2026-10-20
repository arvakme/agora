// The interface language: Chinese (zh) or English (en), one per browser.
//
// Picked once when the page loads, in this order: `?lang=zh|en` in the address (also remembered),
// the choice saved from the ⋯ menu, then the browser's language (zh* → zh, anything else → en).
// Changing it reloads the page, so strings may be read at module load as well as at render time.
// Outside a browser (vitest, node scripts) it is zh, which keeps the existing tests' expectations.
//
// Writing strings: `tr("保存", "Save")` at the call site; for strings with values use a template on
// both sides: `tr(`${n} 轮`, `${n} turns`)`. Keep the Chinese first so the source stays readable for
// the existing docs and tests.
export type Lang = "zh" | "en";

const KEY = "agora.lang";

function detect(): Lang {
  if (typeof window === "undefined") return "zh";
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "zh" || q === "en") {
      try {
        localStorage.setItem(KEY, q);
      } catch {
        /* private window: this page only */
      }
      return q;
    }
  } catch {
    /* no location */
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* blocked storage */
  }
  const nav = typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language ?? "" : "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = detect();

export const lang = (): Lang => current;

/** Pick the string for the current language. */
export const tr = (zh: string, en: string): string => (current === "en" ? en : zh);

/** Switch the interface language and reload, so every string (also ones read at module load) follows. */
export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private window: the address below still carries it */
  }
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  location.replace(url.toString());
}

/** For tests: set the language without a page. */
export function setLangForTest(next: Lang) {
  current = next;
}

/** BCP 47 tag for <html lang>, Intl and Excalidraw. */
export const langTag = (): string => (current === "en" ? "en" : "zh-CN");

if (typeof document !== "undefined") document.documentElement.lang = langTag();

// What the server writes itself (error messages, notices in a session, the build replay's sentences, a dispatch's
// receipt) follows the page: every request carries this cookie (fetch, EventSource and the page load alike), and the
// owner's server also keeps the last one for what it says on its own (server/i18n.py).
if (typeof document !== "undefined") {
  try {
    document.cookie = `agora_lang=${current}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* cookies blocked: the server falls back to the browser's Accept-Language */
  }
}
