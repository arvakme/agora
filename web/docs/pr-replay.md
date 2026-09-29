# PR 回放：按提交生成的数据

选中一个已合并的 PR，工位视图里一个小人按提交顺序走过这个 PR 改过的节点，节点亮起并显示改了几个文件。**这是按提交生成的回放，不是 agent 当时的真实操作**——页面上要写明。数据由 `agora replay import-pr` 生成，服务端只读提供；页面部分见工位视图文档。

## 命令

```bash
agora replay import-pr 4327 4319 4315 --project <项目> [--repo owner/name] [--agent claude|codex|pi|grok|cursor|devin|unknown]
```

每个 PR 写一个 `<项目>/.agora/replays/pr-<N>.json`（已存在就覆盖），打印一行摘要：提交数、文件数、来源、agent。不读任何凭据文件，`gh` 自己处理登录。有 PR 失败时退出码为 1，其余照常导入。

## 来源规则

1. **github**：`gh pr view N --json number,title,author,url,mergedAt,commits,headRefName`，再对每个提交 `gh api repos/{owner}/{repo}/commits/{oid}` 取文件（filename、status、additions、deletions）。仓库默认从项目 git 的 `origin` 远端推出，`--repo` 覆盖。提交按时间升序，同一提交里的文件保持 GitHub 给的顺序。**合并 main 的提交（两个父提交）不算**：它带的是别的 PR 的文件。
2. **squash**：`gh` 不可用、没登录或失败时，退回到项目 git 历史里标题以「(#N)」结尾的提交，用 `git show -M --name-status/--numstat` 取文件。此时只有一个提交，没有分支名。找不到这样的提交就报错、什么也不写。

## agent 字段

`"agent": {"kind": "claude|codex|pi|grok|cursor|devin|unknown", "source": "flag|session|none", "session": "<原生 id，可选>"}`

- `--agent <kind>`：`source: flag`。
- 没给时尽力自动识别，`source: session`：只读地在 `~/.claude/projects`、`~/.codex/sessions`、`~/.pi/agent/sessions` 里找日志，看它是否提到 PR 的 head 分支名（如 `gone-fix2`，工作树叫 `wt-gone-fix2` 的算三倍）。只看与「第一个提交前 2 小时到合并后 1 小时」有重叠的日志：日志的修改时间不早于窗口起点，且第一条记录的时间不晚于窗口终点（一次会话跨了好几个 PR 时，修改时间会晚于合并，所以不能只看修改时间）。提到最多的那个会话胜出；`session` 是 CLI 认的会话 id（Claude 子代理的日志归到它的父会话）。
- 找不到，或来源是 squash（没有分支名）：`{"kind": "unknown", "source": "none"}`。

## 文件格式

```json
{
  "id": "pr-4315", "kind": "pr", "number": 4315,
  "title": "…（#4314）", "author": "Arvak", "url": "https://github.com/…/pull/4315",
  "mergedAt": "2026-09-28T08:07:27Z",
  "source": "github", "branch": "gone-wait",
  "agent": {"kind": "claude", "source": "session", "session": "41a8454c-…"},
  "commits": [
    { "sha": "…", "title": "提交标题第一行", "at": "2026-09-28T07:59:34Z",
      "files": [ { "path": "controlplane/internal/runorch/x.go", "op": "edit", "additions": 12, "deletions": 3 } ] }
  ]
}
```

`op`：`add | edit | delete | rename`（rename 的 path 是新路径）。`path` 相对仓库根目录；落在哪个节点由页面按画布的 codePaths 自己映射，文件里不存节点。

## 接口

- `GET /api/project/replays`：`[{id, kind, number, title, author, mergedAt, source, agent, commits: n, files: n}]`，PR 号大的在前。
- `GET /api/project/replays/<id>`：完整内容。`id` 只能是 `pr-<数字>`，否则 400；不存在 404。只读，沿用 `/api/project` 的鉴权与 Host 检查。

## 限制

- 生成的回放不是真实操作：小人走的顺序是提交顺序，不含 agent 读了什么、试了什么、走了多少弯路。
- squash 回退时只有一个提交，回放退化成「一次走完所有节点」。
- squash 合并的 PR，GitHub 上的原始提交要仍能通过 `refs/pull/N/head` 取到（通常可以，分支删了也一样）。
- 识别 agent 只是尽力而为：日志里没提到分支名的会话认不出来，误认的可能性由分支名是否独特决定（如 `cursor-size`）。
