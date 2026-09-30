// Agent replies are Markdown. This renders the common subset — headings, paragraphs, lists
// (nested, ordered, task), fenced code, block quotes, tables, rules, and inline code / bold /
// italic / strike / links — straight into React elements. Nothing is ever parsed as HTML:
// tags in the text stay text (React escapes them), and links only keep http(s) and mailto
// targets, so a reply cannot run script or load anything by itself.
import { Fragment, memo, type ReactNode } from "react";

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task?: boolean; done?: boolean; blocks: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") (cur += "|"), i++;
    else if (s[i] === "|") (out.push(cur.trim()), (cur = ""));
    else cur += s[i];
  }
  out.push(cur.trim());
  return out;
};
const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/** Split Markdown text into blocks. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join("\n") });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (HR.test(line) && !para.length) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push({ t: "table", align, head, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item && (!para.length || indentOf(line) === 0)) {
      flush();
      i = parseList(lines, i, out);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

/** One list starting at `lines[i]`; nested lists and continuation lines belong to their item. */
function parseList(lines: string[], i: number, out: Block[]): number {
  const first = ITEM.exec(lines[i])!;
  const base = indentOf(lines[i]);
  const ordered = /\d/.test(first[2]);
  const items: { task?: boolean; done?: boolean; blocks: Block[] }[] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i++;
    // Continuation: deeper-indented lines, or blank lines followed by deeper-indented lines.
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const next = lines.slice(i + 1).find((x) => x.trim());
        if (next !== undefined && indentOf(next) > base) (body.push(""), i++);
        else break;
        continue;
      }
      if (indentOf(l) > base) body.push(l.slice(Math.min(indentOf(l), base + 2 + (ordered ? 1 : 0))));
      else break;
      i++;
    }
    const task = /^\[([ xX])\]\s+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    items.push({ ...(task && { task: true, done: task[1] !== " " }), blocks: parseBlocks(body.join("\n")) });
  }
  out.push({ t: "list", ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1, items });
  return i;
}

/** Only web and mail links survive; anything else (javascript:, data:, relative paths) is text. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"，。；：！？」』）])/;

/** Inline Markdown → React nodes. Single newlines are line breaks (chat replies rely on them). */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const plain = (s: string) => {
    const parts = s.split("\n");
    parts.forEach((p, j) => {
      if (j) out.push(<br key={`${key}-br${n++}`} />);
      if (p) out.push(p);
    });
  };
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) break;
    plain(rest.slice(0, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{m[2].replace(/^ (.*) $/, "$1")}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={k}>{inline(m[3] ?? m[4], k)}</strong>);
    else if (m[5]) out.push(<del key={k}>{inline(m[5], k)}</del>);
    else if (m[6]) out.push(<em key={k}>{inline(m[6], k)}</em>);
    else if (m[7]) {
      const href = safeHref(m[8]);
      out.push(href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{inline(m[7], k)}</a> : <Fragment key={k}>{inline(m[7], k)}</Fragment>);
    } else if (m[9]) out.push(<a key={k} href={m[9]} target="_blank" rel="noopener noreferrer">{m[9]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  plain(rest);
  return out;
}

function renderBlocks(blocks: Block[], key: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p":
        return <p key={k}>{inline(b.text, k)}</p>;
      case "h": {
        const H = (["h3", "h3", "h4", "h5", "h6", "h6"] as const)[b.level - 1];
        return <H key={k}>{inline(b.text, k)}</H>;
      }
      case "code":
        return (
          <pre key={k} data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case "quote":
        return <blockquote key={k}>{renderBlocks(b.blocks, k)}</blockquote>;
      case "hr":
        return <hr key={k} />;
      case "table":
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>{b.head.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(c, `${k}h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{b.head.map((_, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(r[j] ?? "", `${k}r${ri}c${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={k} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, j) => (
              <li key={j} data-task={it.task ? (it.done ? "done" : "open") : undefined}>
                {it.task && <input type="checkbox" checked={!!it.done} readOnly disabled aria-label={it.done ? "已完成" : "未完成"} />}
                {/* A tight item leads with inline text (bullets line up with it); nested lists follow. */}
                {it.blocks[0]?.t === "p" ? [...inline(it.blocks[0].text, `${k}.${j}`), ...renderBlocks(it.blocks.slice(1), `${k}.${j}r`)] : renderBlocks(it.blocks, `${k}.${j}`)}
              </li>
            ))}
          </L>
        );
      }
    }
  });
}

/** Memoized on the text: a streaming reply re-renders only the message that grew, not every message on each clock tick. Unclosed syntax (a bold, a fence, a list) renders as far as it goes. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `md ${className}` : "md"}>{renderBlocks(parseBlocks(text), "b")}</div>;
});
