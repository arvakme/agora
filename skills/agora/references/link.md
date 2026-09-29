# Link elements to code (progress pointer)

A box or frame can stand for part of the codebase. Its code paths are globs relative to the
project root. When the session edits a file, Agora moves one pointer onto the element whose
glob matches it (most specific wins) and lists unmatched files as "outside the diagram".
Behaviour: web/docs/progress-pointer.md.

```bash
agora canvas link api 'server/**'                        # element id or its exact label
agora canvas link "Web 前端" 'web/src/**' 'web/index.html'  # adds to what is there
agora canvas link api 'server/api/**' --clear             # replace; --clear alone removes
agora canvas link --json '{"api": ["server/**"], "db": ["db/**"]}'   # several, one undoable change
```

Result `linked` (exit 0), otherwise 1 with `errors`: an element name was ambiguous or unknown,
use ids from `read`. Needs the open page (exit 3 without).

When asked to link the diagram to the code structure (「按代码结构给架构图关联路径」):

1. `agora canvas read`: note each node's / frame's id, label and existing `codePaths`.
2. Check the layout (`git ls-files | cut -d/ -f1-2 | sort -u`). Prefer whole directories;
   file globs only where one directory holds several elements. Leave users and external
   services unlinked.
3. One `link --json '{…}'`, then tell the person which element got which paths and what was left.
