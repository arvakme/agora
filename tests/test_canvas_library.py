"""server.canvas.library tests — keyword search and item lookup over the vendored catalog.
Cross-implementation parity with the spike's TypeScript search is verified separately by
web/scripts/lib-parity.ts (50 fixed queries, identical top-8 ids)."""

import pytest

from server.canvas.library import Library


@pytest.fixture(scope="module")
def lib() -> Library:
    return Library()


def test_search_returns_scored_hits(lib: Library):
    hits = lib.search("redis")
    assert hits
    for hit in hits:
        assert "/" in hit["id"] and "#" in hit["id"]  # <lib-key>/<item>#<n>
        assert hit["score"] > 0
        assert set(hit) >= {"id", "name", "library", "source", "license", "size", "elements", "hasText"}
    assert hits[0]["score"] >= hits[-1]["score"]
    assert len(hits) <= 8


def test_search_chinese_expansion(lib: Library):
    hits = lib.search("数据库")
    assert hits
    assert any("database" in h["name"].lower() or "db" in h["name"].lower() for h in hits)


def test_search_limit_and_cap(lib: Library):
    assert len(lib.search("aws", 3)) == 3
    assert len(lib.search("icon", 999)) <= 20


def test_empty_query_yields_nothing(lib: Library):
    assert lib.search("") == []
    assert lib.search("  ") == []


def test_item_lookup_roundtrip(lib: Library):
    top = lib.search("kafka")[0]
    item = lib.item(top["id"])
    assert item is not None
    assert item["id"] == top["id"]
    assert item["name"] == top["name"]
    assert isinstance(item["elements"], list) and item["elements"]
    assert item["license"] == top["license"]


def test_unknown_item_is_none(lib: Library):
    assert lib.item("nope:nothing") is None


def test_libs_lists_sources(lib: Library):
    libs = lib.libs()
    assert libs
    for entry in libs:
        assert set(entry) == {"key", "source", "name", "license", "items", "file"}
