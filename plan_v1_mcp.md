# Qoneqt v1 MCP — End-to-End Plan

Single deliverable: a Model Context Protocol server, owned by Qoneqt, that gives any coding agent (Claude Code, Cursor, Cline) precise, fresh, v1-grounded context — so the 14-person dev team's agents stop hallucinating in v1.

**Scope locked:** Qoneqt-Web-App-v1 only. v2 deferred. ~3 weeks of focused work, end-to-end.

---

## 1. What v1 actually is (the design constraints)

| Fact | Implication |
|---|---|
| 647 src files (406 .jsx + 241 .js), **0 TypeScript** | Tree-sitter > LSP. tsserver-on-plain-JS is inference-only and weak. We use tree-sitter directly. |
| 175,056 LOC; biggest files 7K–13K lines | `outline_file` and bounded `read_file(path, line_range)` are mandatory. Agents must never read whole files blind. |
| **179 files use raw `fetch()`** vs. 4 Apollo / 1 GraphQL / 2 Supabase | The data layer is REST-to-Go-backend. The most valuable tool is mapping `fetch` ↔ endpoint, both directions. |
| Next.js 15 App Router, **153 pages** | File-system routing means `src/app/<route>/page.js` IS the route. Page lookup tool is cheap and high-value. |
| `src/app/walter_white/*` | Admin section. Big monolithic pages (2K–7K lines each). |
| `src/components/common/` has **346 files** flat | Folder structure provides no navigation help. Search is the only access. |
| **11 React contexts** (Auth, Feed, Kyc, Message, Profile, Toast, Layout, Dashboard, PostDelete, Ai, tooltip) | `find_context_usage(name)` deserves its own tool — providers + consumers. |
| Custom `server.js` (198 lines) + `middleware.js` + `instrumentation.js` | Routes exist outside Next.js routing too. Document them. |
| Path alias: `@/* → ./src/*` (only one) | Import resolution is trivial. |
| **6,808 commits** in git | Rich source for `explain_why`. |
| Web3: wagmi + viem + ethers + RainbowKit; identity: NextAuth + Aadhar/PAN/face | Domain-heavy. AGENTS.md must capture this. |
| Tests: not visible in src | Build-passes is the only deterministic validator. |

---

## 2. What we learn from Serena (and what we don't)

**Borrow the patterns:**
- **Small, composable tool surface** — not one mega-tool. ~12 tools, each with one job.
- **Symbol-level operations** as the spine: `find_symbol`, `find_references`, `outline_file`.
- **Pattern-search fallback** (`search_for_pattern`) for when symbols don't help.
- **Per-project memory** — `.qoneqt-mcp/memories/*.md`, agent reads/writes notes that persist across sessions.
- **Onboarding flow** — first connect indexes everything and writes initial memory files (architecture map, conventions, gotchas).

**Don't borrow:**
- **LSP backbone.** Serena uses LSP for symbol intelligence. For plain JS that means tsserver-with-allowJs, which works but is inference-only and slower than tree-sitter on this codebase. We use tree-sitter directly. Faster, deterministic, no LSP process to manage.
- **Multi-language scaffolding.** v1 is JS-only. Don't pay for generality we don't need.
- **Symbolic editing tools** (`replace_symbol_body`, `insert_after_symbol`, `safe_delete`). The agent already has a generic `Edit` tool. Wait until devs ask before adding.
- **`rename` tool.** Same reason. Tree-sitter-based rename across 647 files is real engineering; defer.

---

## 3. Tool surface — the actual API we ship

**Read & navigate (Serena-shaped):**
1. `read_file(path, line_range?)` — bounded reads. No whole-file dumps of 7K-line monoliths.
2. `outline_file(path)` — tree of top-level symbols (components, functions, hooks, exports) with line numbers.
3. `find_symbol(name, kind?)` — kind ∈ {component, hook, context, function, page, api_route}. Returns file:line + signature.
4. `find_references(name)` — all usages.
5. `search_for_pattern(regex, glob?)` — ripgrep-backed fallback.
6. `list_files(glob)` — `src/app/**/page.js`, etc.

**v1-specific (the differentiators):**
7. `list_pages()` — all 153 App Router pages → `{route, file, layout_chain}`.
8. `find_page(route_or_path)` — exact route lookup with the layout chain.
9. `list_api_routes()` — `src/app/api/**` + custom server.js routes.
10. `find_fetches(file_or_glob)` — extract every `fetch()` call site → `{url, method, headers_keys, file, line}`.
11. `find_endpoint_callers(url_pattern)` — given a backend endpoint (`/api/users/:id`), find every caller in v1.
12. `find_context_usage(name)` — for any of 11 contexts, return providers + consumers + the values exposed.
13. `find_similar_component(description)` — semantic search over `src/components/common/`'s 346 files. Embedding-backed.

**Why & memory:**
14. `explain_why(path_or_symbol)` — git blame at the symbol's lines → commit messages → PR titles/bodies (via `gh api` if available) → relevant TODO/comment markers nearby.
15. `read_memory(name)` / `list_memories()` / `write_memory(name, body)` — `.qoneqt-mcp/memories/*.md`.
16. `onboard()` — one-shot: index repo, write initial memory files (architecture overview, contexts inventory, key conventions, common gotchas).

That's 16 tools. The agent picks. Most invocations will hit 5–7 of them; the rest are long-tail.

---

## 4. Architecture

**Language:** Node.js + TypeScript (the MCP server itself in TS, even though the indexed code is JS — better DX, type safety for our own code).

**Stack:**
- `@modelcontextprotocol/sdk` — official TypeScript MCP SDK.
- `web-tree-sitter` (WASM) + `tree-sitter-javascript` grammar — parsing. Single bundle, no native compile pain.
- `better-sqlite3` — symbol/file/import index. Single file, fast, transactional.
- `sqlite-vec` — vector search inside the same SQLite. Avoid Milvus/Qdrant for our scale (1,300 chunks).
- `@xenova/transformers` (`bge-small-en-v1.5`, ~33MB, runs on CPU) — local embeddings, no API key, no per-call cost. Falls back to `text-embedding-3-small` if user prefers.
- `chokidar` — file watcher.
- `simple-git` — git blame/log. Shell out to `gh api` for PRs.
- `ripgrep` (system binary) for `search_for_pattern`.

**Process model:** single Node process per dev machine, spawned by Claude Code/Cursor as an MCP stdio child. No daemon, no shared host. The SQLite index lives in `.qoneqt-mcp/index.sqlite` (gitignored) and is incrementally rebuilt by the watcher.

**Repository layout:**

```
qoneqt-mcp/
├── package.json
├── README.md                     # install + run instructions for devs
├── tsconfig.json
├── src/
│   ├── server.ts                 # MCP entry, tool registration
│   ├── tools/
│   │   ├── read.ts               # read_file, outline_file, list_files
│   │   ├── search.ts             # find_symbol, find_references, search_for_pattern
│   │   ├── pages.ts              # list_pages, find_page, list_api_routes
│   │   ├── fetches.ts            # find_fetches, find_endpoint_callers
│   │   ├── contexts.ts           # find_context_usage
│   │   ├── similar.ts            # find_similar_component (embeddings)
│   │   ├── why.ts                # explain_why (git + gh)
│   │   ├── memory.ts             # read/write/list memory
│   │   └── onboard.ts            # one-shot onboarding
│   ├── index/
│   │   ├── parser.ts             # tree-sitter wrapper
│   │   ├── resolver.ts           # @/* alias + relative imports
│   │   ├── extract/              # symbol/component/hook/context/fetch extractors
│   │   ├── store.ts              # SQLite schema + queries
│   │   ├── embeddings.ts         # bge-small via transformers.js
│   │   └── watcher.ts            # chokidar → incremental reindex
│   └── lib/
│       └── git.ts
└── grammars/
    └── tree-sitter-javascript.wasm
```

**SQLite schema (sketch):**
- `files(path, hash, indexed_at)`
- `symbols(id, file_id, name, kind, start_line, end_line, signature)` — kind ∈ component, function, hook, context, page, api_route, fetch_call
- `imports(file_id, imported_path, imported_name, alias_resolved)`
- `references(symbol_id, file_id, line)`
- `fetches(file_id, line, url_template, method, has_auth)`
- `chunks(symbol_id, text, embedding BLOB)` — sqlite-vec
- Plus FTS5 virtual table for `search_for_pattern` and identifier search.

---

## 5. Build sequence (3 weeks, end-to-end)

### Week 1 — Foundation + read-only tools
- Day 1–2: Repo scaffold, MCP SDK plumbing, "hello world" tool registered and callable from Claude Code.
- Day 3–4: Tree-sitter pipeline. Walk `src/`, parse, extract top-level symbols + imports + fetch calls, write to SQLite. One-shot indexing.
- Day 5: chokidar watcher → incremental update. Write tools 1–6 (`read_file`, `outline_file`, `find_symbol`, `find_references`, `search_for_pattern`, `list_files`).
- **End-of-week demo:** agent finds any component/function/hook in v1, gets the right line numbers, and follows imports without hallucinating.

### Week 2 — v1-specific tools
- Day 1: `list_pages`, `find_page`, `list_api_routes` (App Router walker).
- Day 2–3: `find_fetches`, `find_endpoint_callers` (the data-layer tool — extract URL templates from `fetch` AST nodes, store, query both directions).
- Day 3: `find_context_usage` (find the 11 context definitions, walk references).
- Day 4–5: `find_similar_component` — embed all components in `src/components/`, query via cosine in sqlite-vec.
- **End-of-week demo:** agent answers "which page uses /api/v1/users/:id?" and "show me an existing component that displays a user card with verified badge" instantly.

### Week 3 — Why, memory, onboarding, deploy
- Day 1: `explain_why` — git blame → log → `gh pr view`.
- Day 2: `memory` tools + `onboard()` — first-connect indexes + writes 4–6 markdown files into `.qoneqt-mcp/memories/` (architecture, contexts, conventions, data-layer map, key gotchas).
- Day 3: Generate `AGENTS.md` for v1 root — tells the agent which tools to use when ("before writing a fetch, call `find_fetches` for an existing pattern; before creating a component, call `find_similar_component`").
- Day 4: Polish, error handling, perf check on the 7K-line monolith files.
- Day 5: Ship to all 14 devs. One-command install (`npx qoneqt-mcp init` writes the Claude Code config). Slack/email rollout note. Capture feedback.
- **End-of-week milestone:** all 14 devs have it running. Track tool-call counts via simple stdout logging to know which tools are actually used.

### Week 4+ (after launch)
- Eval set: 20 hand-written v1 tasks ("add a field to settings", "find the kyc retry path", "where do we display verification status"). Run weekly. Track pass rate.
- Iterate on the bottom-quartile tools — drop or fix what nobody uses.
- Then v2.

---

## 6. What we are explicitly NOT building

- LSP integration — tree-sitter is enough for v1's plain JS.
- Multi-language support — JS only.
- Symbolic editing (`replace_symbol_body`, `rename`) — agent's existing `Edit` tool covers this.
- Multi-repo (v1 + v2 simultaneously) — v2 is out of scope by user decision.
- Server/daemon mode — stdio MCP per dev. No infra.
- Custom embedding training — `bge-small` off the shelf is fine at our scale.
- Sourcegraph/Augment integration — not needed at 14 devs.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `Icons.jsx` (13K lines) and other monoliths blow up tree-sitter or embeddings | Hard line-count cap on what gets embedded; outline-only for files >2K lines |
| `fetch` URLs are dynamic strings (template literals, conditional concatenation) | Extract whatever's statically resolvable; mark dynamic ones as `pattern_unresolved` and surface them as a class. Most internal calls are static base + path. |
| Index drift if watcher misses events (large rebases) | `qoneqt-mcp reindex` command. Also re-validate file hashes on every tool call (cheap). |
| Devs don't adopt — agents don't call our tools | AGENTS.md is the answer; explicitly instructs which tool to call when. Vercel's eval shows this is the lever. |
| Embedding model 33MB download | One-time, cached. Acceptable. |
| Git blame on long-history files is slow | Only blame the requested line range. |

---

## 8. Decision points before kickoff

1. **MCP server language: TypeScript (Node).** OK? Alternative is Python (more popular for MCP) — but our team writes JS, so TS keeps everything in one stack.
2. **Embedding model: local `bge-small`.** OK? Alternative is OpenAI `text-embedding-3-small` — slightly higher quality, $0.02/1M tokens, requires API key. For 1,300 components (~few thousand chunks) the cost difference is sub-$1. Local is simpler.
3. **Deploy model: stdio per-dev.** OK? Alternative is a shared HTTP server. Stdio is simpler, no auth/network concerns, but each dev re-indexes locally (one-time, ~30s).
4. **Scope confirmed: skip `rename` and `replace_symbol_body`.** OK? They're the most expensive Serena-shaped tools to build right and the agent's existing edit tools already work.
5. **AGENTS.md authorship: I draft, you edit.** Want me to write the first version as part of week 3, or start it earlier?

Default-yes to all five and we begin Week 1, Day 1.
