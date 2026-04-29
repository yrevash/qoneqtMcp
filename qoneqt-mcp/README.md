# qoneqt-mcp

Internal MCP (Model Context Protocol) server for the Qoneqt v1 codebase.

Gives any MCP-aware coding agent (Claude Code, Cursor, Cline) precise, fresh, project-grounded context — so agents working on v1 stop hallucinating internal APIs, components, fetch URLs, call sites, and rationale.

## Status

**v0.4.0** — Week 3 + activity attribution, schema versioning, git-hook installer. 26 tools.

## Tools (26)

### Read & navigate
| Tool | Purpose |
|---|---|
| `read_file` | Bounded line-numbered read. Default 400, max 2000. |
| `list_files` | Glob the workspace (default `src/**/*.{js,jsx}`). |
| `outline_file` | Top-level symbols with line ranges. |
| `find_symbol` | Locate by exact name or prefix; filter by `kind`. |
| `search_for_pattern` | Regex via ripgrep; falls back to grep. |

### App Router
| Tool | Purpose |
|---|---|
| `list_pages` | All App Router pages → route + file + layout chain. |
| `find_page` | Resolve route (`/profile/:id`) to file + layouts. |
| `list_api_routes` | All `src/app/api/**/route.{js,jsx}` + HTTP methods. |

### Data layer (the v1 centerpiece)
| Tool | Purpose |
|---|---|
| `find_fetches` | Every `fetch()` / `axios.*` call site by file or glob. URLs templated. |
| `find_endpoint_callers` | Reverse: given an endpoint, find every caller. Use BEFORE writing a new fetch. |

### Contexts
| Tool | Purpose |
|---|---|
| `find_context_usage` | For a Context: definition + Provider + consumer hook + every mount + every consumer. |

### Semantic search (local hybrid)
| Tool | Purpose |
|---|---|
| `find_similar_component` | BM25 (FTS5) + local dense embeddings + optional local cross-encoder rerank, merged via Reciprocal Rank Fusion. |

### Why & memory (Week 3)
| Tool | Purpose |
|---|---|
| `explain_why` | Why does this code exist? Pulls git blame, commit messages, linked PRs + issues, nearby comments, TODO/FIXME markers, ADRs. Optional LLM narrative via `summarize: true`. |
| `list_memories` | Show all per-project memory files (markdown). Call at session start. |
| `read_memory` | Read a memory file. Reserved names: `_index`, `architecture`, `conventions`, `commands`, `gotchas`, `glossary`. |
| `write_memory` | Write/replace a memory (frontmatter generated). Refuses overwrite without `overwrite: true`. |
| `delete_memory` | Remove a memory file. |
| `onboard` | One-shot: bootstrap memory scaffold from the indexed codebase. Idempotent unless `force: true`. |
| `generate_agents_md` | Generate `AGENTS.md` (+ `CLAUDE.md` symlink) at the workspace root. Mechanical sections auto-filled; judgment sections left as TODO. |

### Activity (who-changed-what)
| Tool | Purpose |
|---|---|
| `recent_activity` | Feed of recent file activity. Filter by `user` / `file` substring / `source` (watcher/commit/merge/checkout) / `since_days`. |
| `who_touched` | Top contributors to a specific file (last N days). |
| `what_did_user_do` | Files a specific dev has been touching. |

### Setup
| Tool | Purpose |
|---|---|
| `install_hooks` | Install qoneqt-mcp git hooks (post-commit / post-merge / post-checkout) into the workspace's `.git/hooks/`. |
| `gitignore_template` | Print the recommended `.gitignore` block for a workspace. |

### Admin
| Tool | Purpose |
|---|---|
| `stats` | Index counts + embedding status. |
| `reindex` | Force a full reindex. |

## Prerequisites

- **Bun** ≥ 1.3 — `curl -fsSL https://bun.sh/install | bash`
- **ripgrep** *(optional)* — speeds up `search_for_pattern`. grep fallback works fine.
- **`gh` CLI** *(optional)* — used by `explain_why` for PR/issue lookup. Falls back to GitHub REST if `GITHUB_TOKEN` is set; otherwise blame+commits without PR enrichment.
- **Ollama** *(optional, for local semantic search)* — serves the embedding model locally.
- **Python 3.10+** *(optional, for local reranking)* — runs the small FastAPI rerank sidecar.
- **Anthropic or OpenAI API key** *(optional, for `explain_why summarize:true`)* — Claude Haiku 4.5 narrative summaries.

## Install

```bash
cd qoneqt-mcp
bun install
```

## Index your workspace

```bash
# minimal
bun run index /absolute/path/to/Qoneqt-Web-App-v1

# with local embeddings (recommended)
EMBEDDING_BASE_URL=http://localhost:11434/v1 \
QONEQT_MCP_EMBED_MODEL=qwen3-embedding:8b \
bun run index /absolute/path/to/Qoneqt-Web-App-v1
```

Output for v1 (~647 files):
```
Done in 15.8s + embed 133.0s.
Store: 647 files, 1945 symbols, 5812 imports, 417 fetches, 167 pages, 5 api routes, 992 chunks (992 embedded via local/qwen3-embedding:8b).
```

The index lives at `qoneqt-mcp/.qoneqt-mcp/<workspace-name>/index.sqlite` (gitignored).

## Wire into Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "qoneqt-v1": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/qoneqt-mcp/src/server.ts"],
      "env": {
        "QONEQT_MCP_WORKSPACE": "/absolute/path/to/Qoneqt-Web-App-v1",
        "EMBEDDING_BASE_URL": "http://localhost:11434/v1",
        "QONEQT_MCP_EMBED_MODEL": "qwen3-embedding:8b",
        "RERANK_BASE_URL": "http://127.0.0.1:8081",
        "QONEQT_MCP_RERANK_MODEL": "Qwen/Qwen3-Reranker-8B",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Code; run `/mcp` — should show `qoneqt-v1` with **26 tools**.

## First-time bootstrap

Once connected, run these from inside the agent (one time per workspace):

1. `onboard` — writes the 6 canonical memory files into `<workspace>/.qoneqt-mcp/memories/`. Edit the `<!-- TODO -->` blocks afterward to capture v1-specific judgement.
2. `generate_agents_md` — writes `AGENTS.md` (and a `CLAUDE.md` symlink) at the workspace root. Edit the `<!-- TODO -->` blocks (anti-patterns, allowed/ask/never).

After that, every session the agent reads `_index` first and works from there.

## Memory model

Memories live at **`<workspace>/.qoneqt-mcp/memories/<name>.md`** — markdown with YAML frontmatter:

```markdown
---
title: Architecture
scope: "*"
status: stable           # stable | drifting | deprecated
last_verified: 2026-04-28
related: [conventions, commands]
---

# Architecture
...
```

**Reserved files** (Serena + Anthropic + Cursor convention):
- `_index.md` — table of contents; agent reads first
- `architecture.md` — stack + data flow
- `conventions.md` — naming, error handling, fetch pattern
- `commands.md` — exact dev/build/test invocations
- `gotchas.md` — "don't do X / it breaks Y"
- `glossary.md` — domain terms

**Skip:** activity logs, file-touch history (git handles it), per-component notes (rot quickly).

`.qoneqt-mcp/` is gitignored by default. Opt-in to commit `.qoneqt-mcp/memories/` if you want them reviewed in PRs.

## `explain_why` pipeline

Default deterministic. Optional LLM narrative via `summarize: true`.

```
git blame --line-porcelain    →  unique commits
git show --no-patch            →  subjects + bodies (Co-Authored-By: Claude/Copilot stripped)
git log --follow -M30%         →  fallback if blame is sparse (squash merges)
nearby comment block           →  ~15 lines above the range
TODO|FIXME|HACK|XXX|NOTE       →  markers in/around the range
docs/{adr,architecture}/**.md  →  ADRs that mention the symbol/file
gh api .../commits/{sha}/pulls →  PR title + body + linked issues  (if gh or GITHUB_TOKEN)
                                  └─ "closes #N" extracted, issue title + body fetched
ranking                        →  0.5×recency_180d + 0.3×touched_lines + 0.2×has_PR; bots × 0.6
                                  always include the OLDEST blame commit (origin story)
optional summarize:true        →  Claude Haiku 4.5 narrative @ temp 0; cites SHAs; default OFF
```

Output is structured text; an agent can pluck commits / PRs / markers / ADRs / narrative independently.

## Local Semantic Search Stack

Hosted code-search providers are intentionally not wired into this MCP. The recommended path is local embeddings plus an optional local reranker, so code context stays on the dev machine.

| Stage | Model | Tooling | VRAM | Why |
|---|---|---|---|---|
| Code embedding | **Qwen3-Embedding-8B** | Ollama | GPU recommended | Top local Qwen3 embedding model; strongest option in the local stack. |
| Reranker | **Qwen3-Reranker-8B** | sentence-transformers sidecar | GPU recommended | Top local Qwen3 reranking model; improves final ordering. |
| LLM narratives | (skip locally; or use Anthropic API) | — | — | Local LLM narratives possible via Ollama but quality drops noticeably. |
| Lexical | **SQLite FTS5 (BM25)** | built-in | — | |
| Merge | **Reciprocal Rank Fusion (k=60)** | built-in | — | |

**One-time setup:**
```bash
bun run setup-local-stack   # ollama pull + python venv + sentence-transformers + fastapi + uvicorn
```

**Then start the rerank server (long-running; one terminal):**
```bash
bun run rerank-server
# loads Qwen3-Reranker-8B; serves /rerank on :8081
```

**Wire into your Claude Code MCP env:**
```json
"env": {
  "QONEQT_MCP_WORKSPACE": "/abs/path/Qoneqt-Web-App-v1",
  "EMBEDDING_BASE_URL": "http://localhost:11434/v1",
  "QONEQT_MCP_EMBED_MODEL": "qwen3-embedding:8b",
  "RERANK_BASE_URL": "http://127.0.0.1:8081",
  "QONEQT_MCP_RERANK_MODEL": "Qwen/Qwen3-Reranker-8B"
}
```

Reindex once to populate vectors. After that, dense queries are local and fast; rerank latency depends on the dev machine's GPU/CPU.

### Pick order in the code

When the server starts, it picks providers in this order (first match wins):

**Embedder:** `EMBEDDING_BASE_URL` → BM25-only
**Reranker:** `RERANK_BASE_URL` → no rerank

For team rollout, use `EMBEDDING_BASE_URL` and `RERANK_BASE_URL`. Hosted embedding/rerank providers are not used by this MCP.

### Other env knobs
- `ANTHROPIC_API_KEY` — `explain_why summarize:true` narrative.
- `GITHUB_TOKEN` — REST fallback if `gh` CLI not installed.
- `QONEQT_MCP_EMBED_MODEL` / `QONEQT_MCP_RERANK_MODEL` / `QONEQT_MCP_LLM_MODEL` — model overrides.

If no embedding URL is set, `find_similar_component` degrades to BM25-only and `explain_why` works fully (just no narrative). The MCP is functional with no external services.

## File watcher (automatic)

When the server starts, a chokidar watcher over `src/**/*.{js,jsx}` runs in the background:

- 500 ms debounce
- Re-parses on change/add; updates symbols / imports / fetches / chunks
- Re-walks the App Router on `page.js` / `layout.js` / `route.js` change
- Re-embeds new/changed chunks if an embedder is configured
- **Logs an activity entry per file change** with the current `git config user.name` as actor
- Tails `<workspace>/.qoneqt-mcp/git-events.jsonl` every 2 s and ingests git-hook events
- Logs to stderr only

You generally never need to call `reindex` after the initial index.

## Activity & attribution (handling code pushes)

Every file change is attributed to a dev. Two sources feed the same activity table:

**1. Live edits — chokidar watcher.** Every save tags the modified file with the local `git config user.name`. Useful for "what is X working on right now?".

**2. Git operations — installed hooks.** Run `install_hooks` (or `bun run install-hooks <workspace>`) once per workspace. It drops three scripts into `<workspace>/.git/hooks/`:

| Hook | Fires on | Logs |
|---|---|---|
| `post-commit` | `git commit` | One event per changed file + the commit subject + author SHA |
| `post-merge` | `git pull` / `git merge` | The merge with the local user as actor + branch |
| `post-checkout` | `git checkout` / `git switch` (branch only) | Branch switch with from/to SHAs |

Hooks emit JSONL into `<workspace>/.qoneqt-mcp/git-events.jsonl`. The MCP watcher ingests this every 2 s into the SQLite activity table.

**Workspace `.gitignore` recommendation** (call `gitignore_template`):

```gitignore
# qoneqt-mcp: ignore the local index + event log, COMMIT memories
.qoneqt-mcp/*
!.qoneqt-mcp/memories/
```

The `memories/` exception is deliberate: that's how the team shares `architecture.md` / `conventions.md` / `gotchas.md` via PRs.

**Tools that read the activity log:**
- `recent_activity` — agent's view of "what's happening in the codebase"
- `who_touched <file>` — "who knows about this code?"
- `what_did_user_do <user>` — "what is X working on lately?"

## Schema versioning

`Store` carries a `SCHEMA_VERSION` constant. On startup it compares against `meta.schema_version` in the DB; if different, it drops all tables and re-creates them. Devs pulling a new MCP version get an automatic reindex on next launch (~17 s + embedding time). No manual migrations required.

## Smoke test

```bash
bun run test/smoke.ts
```

Spawns the server over stdio, drives every tool, and prints results. Use this to validate after changes. Note: it deletes & rewrites memories under `<v1>/.qoneqt-mcp/memories/`, so review what gets generated.

## Project layout

```
qoneqt-mcp/
├── src/
│   ├── server.ts                # MCP entry — 21 tools + watcher
│   ├── cli/index-cmd.ts         # standalone indexer CLI
│   ├── tools/
│   │   ├── read.ts              # read_file, list_files
│   │   ├── outline.ts           # outline_file
│   │   ├── search.ts            # find_symbol, search_for_pattern
│   │   ├── routes.ts            # list_pages, find_page, list_api_routes
│   │   ├── fetches.ts           # find_fetches, find_endpoint_callers
│   │   ├── context-usage.ts     # find_context_usage
│   │   ├── similar.ts           # find_similar_component (hybrid retrieval)
│   │   ├── memory.ts            # list/read/write/delete_memory
│   │   ├── explain-why.ts       # explain_why pipeline
│   │   ├── onboard.ts           # bootstrap memory scaffold
│   │   ├── agents-md.ts         # AGENTS.md / CLAUDE.md generator
│   │   └── admin.ts             # stats, reindex
│   ├── index/
│   │   ├── parser.ts            # web-tree-sitter wrapper
│   │   ├── extract.ts           # AST → symbols + imports + fetches + chunks
│   │   ├── router.ts            # App Router walker
│   │   ├── indexer.ts           # parse + write
│   │   ├── embeddings.ts        # provider abstraction
│   │   ├── embed-pass.ts        # batch-embed missing chunks
│   │   ├── watcher.ts           # chokidar incremental
│   │   └── store.ts             # bun:sqlite schema
│   └── lib/
│       ├── paths.ts
│       ├── types.ts
│       ├── memory-store.ts      # markdown + YAML frontmatter
│       ├── git.ts               # blame + log + show wrappers
│       ├── github.ts            # gh CLI / REST PR + issue fetch
│       └── llm.ts               # optional Anthropic / OpenAI summarization
├── test/
│   └── smoke.ts                 # end-to-end stdio test
└── package.json
```

## Troubleshooting

**`QONEQT_MCP_WORKSPACE is not set`** — set in MCP `env` block.

**`search_for_pattern` errors** — install ripgrep or ensure grep is on PATH.

**`find_similar_component` says `stages: bm25` only** — start Ollama and set `EMBEDDING_BASE_URL=http://localhost:11434/v1`, then reindex.

**`explain_why` skips PR enrichment** — install `gh` CLI and run `gh auth login`, or set `GITHUB_TOKEN`.

**`explain_why summarize:true` says "no LLM provider"** — set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`).

**Watcher missed a change** — call `reindex`. Likely cause: large `git rebase` rewrote many files; chokidar dedupes the burst.

## What's next (Phase 4)

- **Eval set** (30-50 hand-written task prompts with deterministic pass criteria) for weekly regression measurement.
- **Roll out** to all 14 devs (one-command install, Slack note, capture feedback).
- **Iterate** on which tools actually get used; trim or fix the bottom quartile.
- **v2 MCP** — repeat for Qoneqt-Web-App-v2 once v1 is proven.

See `../plan_v1_mcp.md` and `../plan_v1_mcp_week3.md` for full plans.
