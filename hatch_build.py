"""Hatch build hook: puts the files Agora needs at runtime but that are not Python into the wheel, under
``server/_bundle/`` in the repo's own layout (server/paths.py finds them there).

The page (``web/dist``) is gitignored, so it is built here when missing: ``npm ci`` (only without ``node_modules``)
and ``npm run build`` in ``web/``. That needs Node at build time, which ``uv tool install git+…`` is; a release wheel
or an sdist already carries the page and needs none. ``AGORA_SKIP_WEB_BUILD=1`` builds a wheel without the page
(the server then answers with its "not built" page). Editable installs (``uv sync`` in a checkout) bundle nothing:
the checkout itself is the root there.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

BUNDLE = "server/_bundle"
# What the server reads or serves at runtime, relative to the repo root. web/libraries is the whole vendored asset
# library: the page fetches its items through /libraries/ and its licenses must travel with it.
ASSETS = ("web/libraries", "web/generated", "skills", "bin/agora", "bin/agora-state")
DIST = "web/dist"


class AgoraBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        if self.target_name == "wheel" and version == "editable":
            return
        root = Path(self.root)
        dist = self._ensure_dist(root)
        if self.target_name == "sdist":
            if dist:  # gitignored, so only force-include puts the prebuilt page in the sdist
                build_data["force_include"][str(root / DIST)] = DIST
            return
        for rel in (*ASSETS, *((DIST,) if dist else ())):
            build_data["force_include"][str(root / rel)] = f"{BUNDLE}/{rel}"

    def _ensure_dist(self, root: Path) -> bool:
        """Whether ``web/dist`` is there to bundle, building it first when it is missing and the web sources are here."""
        web = root / "web"
        if (root / DIST / "index.html").is_file():
            return True
        if os.environ.get("AGORA_SKIP_WEB_BUILD"):
            self.app.display_warning("AGORA_SKIP_WEB_BUILD is set: building without the page (web/dist)")
            return False
        if not (web / "package.json").is_file():
            raise RuntimeError("web/dist is missing and there are no web sources to build it from")
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError(
                "building Agora's page (web/dist) needs Node.js 22+ with npm on PATH; install Node, "
                "install a release wheel instead, or set AGORA_SKIP_WEB_BUILD=1 to build without the page"
            )
        self.app.display_info("building web/dist (npm run build)")
        if not (web / "node_modules").is_dir():
            subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=web, check=True)
        subprocess.run([npm, "run", "build"], cwd=web, check=True)
        return True
