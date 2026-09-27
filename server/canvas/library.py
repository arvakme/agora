"""Built-in asset library service: keyword search over libraries/catalog.json and item
lookup from the vendored per-library files. Used by the HTTP routes (panel, executor)
and by the MCP tool the planning agent calls. Nothing here loads the full item set
eagerly; only the catalog index (~2 MB) is kept in memory.

Ported 1:1 from the spike's server/library.ts — the scoring, tokenisation and tie-breaks
must match the TypeScript version exactly (verified by a fixed-query parity check)."""

from __future__ import annotations

import json
import math
import unicodedata
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2] / "web" / "libraries"


def _words(s: str) -> list[str]:
    """Split on anything that is not a letter or number (JS /[^\\p{L}\\p{N}]+/u)."""
    out: list[str] = []
    cur: list[str] = []
    for ch in s.lower():
        # str.isalnum covers Unicode categories L* and N*, matching \p{L}|\p{N}.
        if ch.isalnum():
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def _is_han(word: str) -> bool:
    """JS \\p{Script=Han} — every CJK ideograph block."""
    return all(unicodedata.name(ch, "").startswith("CJK") for ch in word)


# A few common Chinese diagram words map to the English vocabulary of the catalog.
ZH = {
    "数据库": ["database", "db"],
    "缓存": ["cache", "redis"],
    "服务器": ["server"],
    "用户": ["user", "person"],
    "人": ["person", "user"],
    "云": ["cloud"],
    "队列": ["queue"],
    "消息": ["message", "queue"],
    "浏览器": ["browser"],
    "手机": ["phone", "mobile"],
    "电脑": ["computer", "laptop"],
    "网关": ["gateway"],
    "负载均衡": ["load", "balancer"],
    "容器": ["container", "docker"],
    "锁": ["lock"],
    "安全": ["security", "shield"],
    "文件": ["file", "document"],
    "图表": ["chart"],
    "机器人": ["robot", "bot"],
    "箭头": ["arrow"],
    "存储": ["storage"],
    "网络": ["network"],
}


def _query_terms(q: str) -> list[str]:
    out = set(_words(q))
    for zh, en in ZH.items():
        if zh in q:
            out.update(en)
    return [w for w in out if not (_is_han(w) and len(w) > 4)]


def _round1(v: float) -> float:
    """JS Math.round(v * 10) / 10 — halves round toward +Infinity."""
    return math.floor(v * 10 + 0.5) / 10


class Library:
    """Serves the vendored catalog; reloads it when libraries:fetch rewrites it."""

    def __init__(self, root: Path = ROOT) -> None:
        self.root = Path(root)
        self._catalog: dict[str, Any] | None = None
        self._loaded_mtime: float | None = None
        self._libs_by_key: dict[str, dict[str, Any]] = {}
        self._files: dict[str, dict[str, Any]] = {}

    def _load(self) -> dict[str, Any]:
        mtime = (self.root / "catalog.json").stat().st_mtime
        if self._catalog is None or mtime != self._loaded_mtime:
            self._loaded_mtime = mtime
            self._files.clear()
            self._catalog = json.loads((self.root / "catalog.json").read_text())
            self._libs_by_key = {l["key"]: l for l in self._catalog["libraries"]}
        return self._catalog

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        c = self._load()
        terms = _query_terms(query)
        phrase = query.strip().lower()
        if not terms:
            return []
        scored: list[dict[str, Any]] = []
        for it in c["items"]:
            name = it["name"].lower()
            name_words = _words(it["name"])
            lib = self._libs_by_key[it["lib"]]
            score = 0.0
            matched = 0
            for t in terms:
                s = 0
                if t in name_words:
                    s = 5
                elif t in name:
                    s = 3
                elif t in it["kw"]:
                    s = 2
                elif any(k.startswith(t) and len(t) >= 3 for k in it["kw"]):
                    s = 1
                elif t in lib["name"].lower():
                    s = 1
                if s:
                    matched += 1
                score += s
            if not matched:
                continue
            if len(phrase) > 2 and name == phrase:
                score += 6
            elif len(phrase) > 2 and phrase in name:
                score += 3
            score *= matched / len(terms)  # every term should count
            if it["n"] > 60:
                score -= 1.5  # prefer components over whole scenes
            if it["how"] == "model":
                score -= 0.3  # model-labelled names are less certain
            hit: dict[str, Any] = {
                "id": it["id"],
                "name": it["name"] or "(unnamed)",
                "library": lib["name"],
                "source": lib["source"],
                "license": lib["license"],
                "size": {"w": it["w"], "h": it["h"]},
                "elements": it["n"],
                "hasText": bool(it.get("text")) or it["how"] == "text",
                "score": _round1(score),
            }
            if it.get("text"):
                hit["text"] = it["text"]
            scored.append(hit)
        scored.sort(key=lambda h: (-h["score"], h["elements"]))
        return scored[: max(1, min(limit, 20))]

    def item(self, item_id: str) -> dict[str, Any] | None:
        c = self._load()
        it = next((i for i in c["items"] if i["id"] == item_id), None)
        if it is None:
            return None
        lib = self._libs_by_key[it["lib"]]
        if lib["file"] not in self._files:
            self._files[lib["file"]] = json.loads((self.root / lib["file"]).read_text())
        raw = next((i for i in self._files[lib["file"]]["items"] if i["id"] == item_id), None)
        if raw is None:
            return None
        return {
            "id": item_id,
            "name": it["name"],
            "library": lib["name"],
            "license": lib["license"],
            "origin": lib["origin"],
            "elements": raw["elements"],
        }

    def libs(self) -> list[dict[str, Any]]:
        return [
            {k: l[k] for k in ("key", "source", "name", "license", "items", "file")}
            for l in self._load()["libraries"]
        ]
