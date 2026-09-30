"""JSON Schemas generated from the frontend's single source of truth
(``web/scripts/export-schemas.ts`` → ``web/generated/*.schema.json``). The backend
re-validates model output structurally; referential and freshness checks stay in the
browser, which owns the live scene."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

GENERATED = Path(__file__).resolve().parents[2] / "web" / "generated"


@lru_cache
def load(name: str) -> dict[str, Any]:
    """Load a generated schema by file name (``plan.schema.json`` etc.)."""
    return json.loads((GENERATED / name).read_text())


def validate(schema: dict[str, Any], value: Any) -> list[str]:
    """Return human-readable validation errors (empty when valid)."""
    import jsonschema  # imported lazily: not needed when only loading schemas

    return [
        f"{'.'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
        for e in jsonschema.validators.validator_for(schema)(schema).iter_errors(value)
    ]
