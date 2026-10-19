"""Where Agora's own files are: the built page, the asset libraries, the generated schemas, the skill and the
scripts in ``bin/``. The one place that knows; everything else asks ``ROOT``.

A checkout has them at the repo root, next to ``server/``. An installed wheel has them under ``server/_bundle/``
in the same layout (``web/dist``, ``web/libraries``, ``web/generated``, ``skills``, ``bin``), put there by
``hatch_build.py``; that folder never exists in a checkout.
"""

from __future__ import annotations

from pathlib import Path

#: The folder ``agora_cli``, ``server`` and ``native_protocol`` are imported from (the repo, or site-packages).
SOURCE = Path(__file__).resolve().parents[1]
BUNDLE_NAME = "_bundle"
_BUNDLE = Path(__file__).resolve().parent / BUNDLE_NAME

#: Running from a git checkout (``bin/agora``, ``uv run``): web sources, vite and git are there.
CHECKOUT = not _BUNDLE.is_dir()
ROOT = SOURCE if CHECKOUT else _BUNDLE
WEB = ROOT / "web"
BIN = ROOT / "bin"
SKILLS = ROOT / "skills"
