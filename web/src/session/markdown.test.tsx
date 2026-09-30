import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, parseBlocks, safeHref } from "./markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("agent reply markdown", () => {
  it("renders headings, lists, tables and code as elements", () => {
    const out = html("## 路径关联\n\n| 节点 | 路径 |\n|---|---|\n| Agora 后端 | `server/app.py` |\n\n1. 第一\n2. **第二**\n\n```bash\nagora canvas read\n```");
    expect(out).toContain("<h3>路径关联</h3>");
    expect(out).toContain("<th>节点</th>");
    expect(out).toContain("<td><code>server/app.py</code></td>");
    expect(out).toContain("<ol><li>第一</li><li><strong>第二</strong></li></ol>");
    expect(out).toContain('<pre data-lang="bash"><code>agora canvas read</code></pre>');
  });

  it("nests lists by indentation and keeps task state", () => {
    const blocks = parseBlocks("- a\n  - b\n- [x] done");
    expect(blocks).toHaveLength(1);
    const out = html("- a\n  - b\n- [x] done");
    expect(out).toContain("<li>a<ul><li>b</li></ul></li>");
    expect(out).toMatch(/<li data-task="done"><input type="checkbox"[^>]*checked=""[^>]*\/>done<\/li>/);
  });

  it("never turns text into HTML", () => {
    const out = html('<img src=x onerror="alert(1)"> and <script>alert(1)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps only web and mail links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>")).toBeNull();
    expect(safeHref("/api/share")).toBeNull();
    expect(safeHref("https://arvak.me")).toBe("https://arvak.me");
    const out = html("[点我](javascript:alert(1)) 和 [文档](https://example.com/a) 以及 https://example.com/b。");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">文档</a>');
    expect(out).toContain('<a href="https://example.com/b" target="_blank" rel="noopener noreferrer">https://example.com/b</a>。');
  });

  it("keeps single newlines as line breaks and leaves snake_case alone", () => {
    const out = html("第一行\n第二行 my_var_name");
    expect(out).toBe('<div class="md"><p>第一行<br/>第二行 my_var_name</p></div>');
  });
});
