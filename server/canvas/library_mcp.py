"""Minimal MCP (stdio, JSON-RPC 2.0) server exposing the built-in asset library to the
planning agent as the ``search_library`` tool. Spawned by ``claude -p`` per plan call.

Runs standalone too (``python -m server.canvas.library_mcp`` or as a file): the sys.path
bootstrap keeps the Library import working regardless of the caller's cwd.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.canvas.library import Library  # noqa: E402

# How ``claude -p`` spawns this server (run directly as a file so no cwd/PYTHONPATH is needed).
MODULE = [sys.executable, str(Path(__file__).resolve())]

TOOLS = [
    {
        "name": "search_library",
        "description": (
            "Search the built-in Excalidraw asset library (~6k ready-made components: official excalidraw-libraries, community sets, Lucide icons). "
            "Use English keywords (e.g. 'redis', 'database', 'aws lambda', 'user avatar'). Returns candidate items with id, name, library and size; "
            "pass an id to an insert_library_item op. The catalog is never listed in full — search with specific terms."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords or component name"},
                "limit": {"type": "number", "description": "Max results (default 8, max 20)"},
            },
            "required": ["query"],
        },
    }
]


def main() -> None:
    library = Library()
    out = sys.stdout

    def send(msg: dict) -> None:
        out.write(json.dumps({"jsonrpc": "2.0", **msg}, ensure_ascii=False) + "\n")
        out.flush()

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        def reply(result: dict) -> None:
            if req_id is not None:
                send({"id": req_id, "result": result})

        if method == "initialize":
            reply(
                {
                    "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "agora-library", "version": "0.1.0"},
                }
            )
        elif method == "tools/list":
            reply({"tools": TOOLS})
        elif method == "tools/call":
            args = params.get("arguments") or {}
            hits = library.search(str(args.get("query", "")), int(args.get("limit", 8)))
            if hits:
                text = json.dumps([{k: v for k, v in h.items() if k != "score"} for h in hits], ensure_ascii=False)
            else:
                text = f'No library items match "{args.get("query")}". Try other keywords, or draw it yourself with add_shape.'
            reply({"content": [{"type": "text", "text": text}]})
        elif method == "ping":
            reply({})
        elif req_id is not None:
            send({"id": req_id, "error": {"code": -32601, "message": f"unknown method {method}"}})


if __name__ == "__main__":
    main()
