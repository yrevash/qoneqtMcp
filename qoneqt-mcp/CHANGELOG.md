# Changelog

## v0.4.0 — 2026-04-28

Activity attribution, schema versioning, git-hook installer.

### Added
- **Activity log** with per-dev attribution.
  - New table `activity` (ts / user / email / source / ref / file_path / action / detail).
  - Watcher logs `modified` / `added` / `deleted` events tagged with the local git user (`git config user.name`).
  - Git hooks (`post-commit`, `post-merge`, `post-checkout`) emit JSONL events into `<workspace>/.qoneqt-mcp/git-events.jsonl`; the watcher tails the file and ingests every 2 s.
- **5 new MCP tools:**
  - `recent_activity(user?, file?, source?, since_days?, limit?)` — feed of recent changes.
  - `who_touched(file, since_days?, limit?)` — top contributors to a file.
  - `what_did_user_do(user, since_days?, limit?)` — files a specific dev has been editing.
  - `install_hooks()` — installs the three git hook templates into the workspace's `.git/hooks/`.
  - `gitignore_template()` — prints the recommended `.gitignore` block.
- **Schema versioning** (`SCHEMA_VERSION = 2`, `meta.schema_version` row). On `Store` init the constructor compares versions and auto-drops/rebuilds tables if mismatched. Triggers a one-time reindex on dev machines after a schema-bumping release.
- `bun run install-hooks <workspace>` script.

### Notes
- Total tools: **26** (was 21). All previous tools unchanged.
- Recommend committing `.qoneqt-mcp/memories/` to your repo so the team shares architectural knowledge; ignore the rest of `.qoneqt-mcp/` (the index and event log are local).

## v0.3.0 — 2026-04-28

Why layer + memory + onboarding + AGENTS.md generator.

### Added
- `explain_why(path|symbol, line_range?, summarize?)` — git blame + commit show + PR enrichment (gh CLI / GITHUB_TOKEN) + nearby comments + TODO/FIXME markers + ADR scan + optional Anthropic-Haiku narrative.
- Memory system: `list_memories`, `read_memory`, `write_memory`, `delete_memory`, `onboard()`.
- `generate_agents_md()` — writes `AGENTS.md` (and a `CLAUDE.md` symlink) at the workspace root with auto-filled mechanical sections + TODO placeholders for human judgement.

### Stack picks (local-first)
- Local: Qwen3-Embedding-8B (Ollama, GPU recommended) + Qwen3-Reranker-8B (Python sidecar, GPU recommended).
- Hosted code-search providers are not part of the default Qoneqt MCP rollout.
- Provider abstraction selects on env: `EMBEDDING_BASE_URL` → BM25-only. Rerank is local-only via `RERANK_BASE_URL`.

## v0.2.0 — 2026-04-28

v1-specific tools: App Router, fetch ↔ endpoint map, contexts, hybrid semantic search.

### Added
- `list_pages`, `find_page`, `list_api_routes`.
- `find_fetches`, `find_endpoint_callers`.
- `find_context_usage`.
- `find_similar_component` (BM25 + dense + cross-encoder rerank, RRF merge).
- chokidar file watcher with debounced incremental reindex.

## v0.1.0 — 2026-04-28

Foundation.

### Added
- Bun + TypeScript + MCP SDK scaffold.
- web-tree-sitter parser + bun:sqlite index.
- 7 read/search tools: `read_file`, `list_files`, `outline_file`, `find_symbol`, `find_references`, `search_for_pattern`, `stats`, `reindex`.
