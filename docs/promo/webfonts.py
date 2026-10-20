#!/usr/bin/env python3
"""从 Google Fonts 取宣传片用的展示字体，存进构建目录的 assets/fonts/（都是 SIL OFL 1.1）。

  python3 docs/promo/webfonts.py <film/index.html> <build/assets/fonts>

- Instrument Serif（正体 + 意大利体）：英文标题、字幕和字标；只取 latin 子集。
- Noto Serif SC（思源宋体，可变字重 200–900）：中文标题和字幕。全量有十几 MB，这里用 css2 的 text=
  只要片子里真用到的字：<script id="copy"> 里所有文案的字符，再加上可打印 ASCII。
文件名固定，index.html 的 @font-face 直接引用；渲染时不联网。
"""
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def faces(css: str):
    """css2 返回的每个 @font-face：(注释里的子集名, style, src url)。"""
    out = []
    for m in re.finditer(r"(?:/\*\s*([\w-]+)\s*\*/\s*)?@font-face\s*{([^}]*)}", css):
        body = m.group(2)
        style = re.search(r"font-style:\s*(\w+)", body).group(1)
        src = re.search(r"url\(([^)]+)\)", body).group(1)
        out.append((m.group(1) or "", style, src))
    return out


def main():
    html, dest = Path(sys.argv[1]), Path(sys.argv[2])
    dest.mkdir(parents=True, exist_ok=True)

    # Instrument Serif：latin 子集，正体和意大利体各一个文件
    css = get("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=block").decode()
    for subset, style, src in faces(css):
        if subset != "latin":
            continue
        name = "InstrumentSerif-400" + ("i" if style == "italic" else "") + ".woff2"
        (dest / name).write_bytes(get(src))
        print("font", name)

    # Noto Serif SC：按文案取子集（一个可变字重文件）
    copy = json.loads(re.search(r'<script type="application/json" id="copy">(.*?)</script>', html.read_text(), re.S).group(1))
    text = set(chr(c) for c in range(0x20, 0x7F))

    def walk(v):
        if isinstance(v, str):
            text.update(v)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    walk(copy)
    text.update("，。：、“”‘’—·…（）")
    q = urllib.parse.quote("".join(sorted(text)))
    css = get(f"https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@200..900&display=block&text={q}").decode()
    srcs = {src for _, _, src in faces(css)}
    if len(srcs) != 1:
        sys.exit(f"Noto Serif SC: expected one variable subset, got {len(srcs)}")
    (dest / "NotoSerifSC-var.woff2").write_bytes(get(srcs.pop()))
    print("font NotoSerifSC-var.woff2", len(text), "chars")


if __name__ == "__main__":
    main()
