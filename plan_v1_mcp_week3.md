# Qoneqt v1 MCP — Week 3 Plan

Single deliverable: ship the **"why" + memory + onboarding** layer. Closes the universal blind spot of OSS MCP code servers (per the research) and gives Qoneqt's agents persistent project knowledge that survives across sessions.

Research-derived. SOTA-aligned. End-to-end.

---

## 1. What the research validated (April 2026)

### `explain_why` — open lane
Sourcegraph has primitives (`commit_search`, `diff_search`) but no narrative. Augment Code (Feb 2026) ships "tribal knowledge" but is closed-source SaaS. Serena ships zero git tools. `cyanheads/git-mcp-server` wraps raw git but has no PR linkage, no narrative, no ranking. **Building a Serena-grade `explain_why` is genuinely uncontested in OSS.**

**Recommended pipeline (in order, with caching):**
1. **Local-deterministic (sub-100ms):** `git blame --line-porcelain -L start,end` → unique SHAs
2. For each SHA: `git show --no-patch --format=...` → subject + body
3. Nearest comment block above the line range (~15 lines up, JSDoc + `//` cluster)
4. Markers in/around range: `TODO|FIXME|HACK|XXX|NOTE|WHY` regex
5. ADR scan: `docs/adr/**/*.md` and `docs/architecture/**/*.md` greps for symbol/file
6. **PR enrichment (network, ~200–500ms, cached):** `gh api repos/{o}/{r}/commits/{sha}/pulls` per SHA; parse PR body for `(close[sd]?|fix(es|ed)?|resolve[sd]?) #N` → fetch issues
7. **Fallback for sparse blame** (squash merges, big reformats): `git log --follow --no-merges -M30%`
8. **Ranking** for files with 1000+ commits: `0.5 × recency_decay(half_life=180d) + 0.3 × touched_lines + 0.2 × has_PR_body`. Drop merges. Always include the *oldest* commit that introduced the range. Strip `Co-Authored-By: Claude/Copilot` before author ranking.

**LLM summarization: default OFF, opt-in via `summarize: true`.** Reasons:
- Determinism (agents need reproducible output)
- Cost (~$0.007/Haiku 4.5 call × 50–200 calls per session)
- Hallucination risk (arXiv 2508.08661 documented this exact failure)
- Raw output is genuinely useful for agents

When summarization helps: 30+ commits in range OR `format: "narrative"` requested. Use Claude Haiku 4.5 (or fallback) at temperature 0, prompt requires citing SHAs.

**Output: structured JSON** — caller renders text, agent can pluck fields.

### Memory system — Serena pattern wins
Anthropic Memory Tool, Serena, and Cursor `.cursor/rules/*.mdc` all converged on **markdown files with YAML frontmatter, in a directory inside the workspace, committed to git**. Frameworks like Mem0/Zep/Letta lose for code because:
- Not human-editable
- Not git-versioned
- Hide drift behind opaque vector indexes

**Verdict: ship Serena's pattern, native in our MCP. No frameworks. No vector DB for memory.**

**Storage:** `.qoneqt-mcp/memories/<name>.md` in workspace root (or in `qoneqt-mcp/.qoneqt-mcp/<workspace>/memories/`).

**Frontmatter:**
```yaml
---
title: <human title>
scope: <glob like "src/contexts/**" or "*">
status: stable | drifting | deprecated
last_verified: 2026-04-28
related: [conventions, api-routes]
---
```

**Reserved files (Serena+Anthropic+Cursor convention):**
- `_index.md` — table of contents; agent reads first
- `architecture.md` — 1-pager, stack + data flow
- `conventions.md` — naming, error handling, fetch pattern
- `commands.md` — dev / build / test / lint exact invocations
- `gotchas.md` — "don't do X / it breaks Y"
- `glossary.md` — Qoneqt-specific domain terms

**Skip:** activity logs, file-touch history (git handles), per-component notes (rot quickly).

**Tools:** `read_memory(name)`, `write_memory(name, body, frontmatter?)`, `list_memories()`, `delete_memory(name)`.

### Onboarding — scaffold + iterate
`claude-code /init` and Serena's `onboarding` both auto-generate. The 2026 consensus: don't auto-generate prose then walk away. Generate a scaffold; leave judgment sections as `<!-- TODO: ... -->` placeholders for humans.

**`onboard()` writes on first run:**
1. Detect Next.js version + router type → `architecture.md` (mechanical fields filled, "Why X over Y" left as TODO)
2. Read `package.json` scripts → `commands.md` (fully auto)
3. Inventory contexts (from index) → seed `architecture.md` "State management" section
4. Inventory data layer (fetches with templated URLs, top endpoints) → `conventions.md` data-fetching section
5. Stub `gotchas.md` and `glossary.md` with TODO markers
6. Write `_index.md` with all the above
7. Stamp every file with `last_verified` frontmatter

**Idempotent:** if memories exist, onboard reports "already onboarded" and offers `force: true` to overwrite.

### AGENTS.md / CLAUDE.md — pointer + tool-routing > prose
Vercel + ETH Zurich evals (Jan–Feb 2026) bright line:
- Auto-generated prose overviews **lose 3% accuracy and add 20% tokens**.
- **Pointers + non-obvious tool names + decision rules WIN.** Naming a tool by exact registered name caused 160× more correct usage in ETH study.
- Imperative voice ("MUST", "NEVER", "ALWAYS") moves the needle.
- Length: **100–200 lines for root**.
- Claude Code reads `CLAUDE.md` NOT `AGENTS.md` (Issue #6235 still open) — write both or symlink.

**The tool-routing table is the centerpiece of our AGENTS.md.** That's the section nobody else can auto-generate because they don't know our tools.

**`generate_agents_md(target?)`** auto-fills the mechanical sections, leaves judgment sections as TODO. Writes to `<workspace>/AGENTS.md` and `<workspace>/CLAUDE.md` (or symlink).

Auto-fillable fields:
| Section | Source |
|---|---|
| Project identity (stack/version) | `package.json`, lockfile |
| Commands | `package.json` scripts |
| MCP tool list + when-to-use rules | hardcoded in our generator (we know our own tools) |
| File-naming patterns | similarity index over file paths |
| Pointers section | scan `/docs/**/*.md` |
| Conventions data layer | fetch index — top endpoint patterns |
| Conventions state | context index |

Human-only sections (left as TODO):
| Section | Why human |
|---|---|
| Anti-patterns / "don't do X" | requires intent / past-incident knowledge |
| Allowed / Ask First / Never | policy decision |
| Per-area decision rules | requires judgment beyond what's in code |

---

## 2. Tool surface (Week 3 = +7 tools, total 21)

### Memory (4)
| Tool | Signature | Purpose |
|---|---|---|
| `list_memories` | `()` | Show all memory files with title/scope/status/last_verified |
| `read_memory` | `(name)` | Read one memory file (with frontmatter) |
| `write_memory` | `(name, body, frontmatter?)` | Write/replace a memory file. Validates name, stamps `last_verified`. |
| `delete_memory` | `(name)` | Remove a memory file (rare; supported for hygiene) |

### Why
| Tool | Signature | Purpose |
|---|---|---|
| `explain_why` | `(path, line_range?, summarize?)` | Structured output: ranked blame ∪ commit bodies ∪ linked PRs+issues ∪ nearby comments ∪ markers ∪ ADRs ∪ optional narrative |

### Onboarding & meta
| Tool | Signature | Purpose |
|---|---|---|
| `onboard` | `({ force?: false })` | Bootstrap memory scaffold from the indexed codebase |
| `generate_agents_md` | `({ write?: true, target?: workspace })` | Generate or refresh AGENTS.md + CLAUDE.md at workspace root |

---

## 3. Architecture additions

```
qoneqt-mcp/
├── src/
│   ├── lib/
│   │   ├── git.ts              # NEW — git wrapper (blame, log, show, line-porcelain parser)
│   │   ├── github.ts           # NEW — gh CLI wrapper (PR + issue fetch, with caching)
│   │   ├── memory-store.ts     # NEW — fs-based markdown + frontmatter
│   │   └── llm.ts              # NEW — optional Anthropic API for narrative summarization
│   ├── tools/
│   │   ├── memory.ts           # NEW — read/write/list/delete memory tools
│   │   ├── explain-why.ts      # NEW — full pipeline
│   │   ├── onboard.ts          # NEW — bootstrap from index → memory scaffold
│   │   └── agents-md.ts        # NEW — AGENTS.md generator
│   └── server.ts               # +7 tool registrations
└── .qoneqt-mcp/<workspace>/
    └── memories/               # NEW — markdown memory files
```

---

## 4. Sequencing

1. **Memory store + 4 memory tools** (no external deps; pure fs)
2. **Git wrapper + GitHub wrapper** (shell out to `git` and `gh`; cache PR fetches)
3. **`explain_why`** (assembles pipeline; optional LLM via `ANTHROPIC_API_KEY`)
4. **`onboard`** (uses memory tools + reads from index)
5. **`generate_agents_md`** (uses memory + index + hardcoded tool routing table)
6. **Wire into server.ts** (register all 7; ensure memory + git work even when no API keys)
7. **Update smoke test** — at minimum: `list_memories`, `write_memory`, `read_memory`, `onboard`, `generate_agents_md`. (Skip `explain_why` against v1 unless we run inside the workspace's git repo; can hit limits in test env.)
8. **Update README** — Week 3 tools, env vars (`ANTHROPIC_API_KEY` optional), reserved memory file list, onboard flow, AGENTS.md output.

---

## 5. Explicit non-goals

- No vector DB / Mem0 / Letta integration. Markdown wins.
- No automatic `last_verified` extension via re-checking files. Stamping is on write only.
- No automatic prose generation in `AGENTS.md`. Mechanical sections + TODO placeholders only.
- No git operations beyond read (no `git commit`, no `git checkout`, no `git fetch`). The MCP is read-only against the user's repo state.
- No conversation transcripts captured. (Cursor 2.4 / Git AI do this; out of scope.)
- No Slack / Linear / Jira yet — separate future MCPs.

---

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `git log --follow` breaks on rename+edit | Use `-M30%` and fall back to plain `git log` if <3 commits returned |
| `gh` CLI not installed | Detect at startup; fall back to GitHub REST via `fetch` if `GITHUB_TOKEN` set; otherwise return blame+commits without PR enrichment with a clear note |
| Squash merges hide intra-PR commits | Treat the merge commit's PR body as the primary signal; weight it accordingly in ranking |
| Workspace not a git repo | All git tools detect this and return a clean "not a git repo" message rather than crashing |
| Memory file conflict on write | Detect existing file; if `overwrite: false` (default), error; if `true`, write |
| Stale memories | `last_verified` frontmatter; surface in `list_memories` with age |
| LLM hallucination in narratives | Disable by default. When enabled, prompt requires citing SHAs and forbids invention. Temperature 0. |
| Recency-weighted scoring biases toward churny config files | Cap recency bias when blame line is itself >1 year old |
| `Co-Authored-By: Claude` flooding author signal | Strip Claude/Copilot/Codex co-authors before author ranking |

---

## 7. Decision points (defaults; speak up to override)

1. **LLM summarization for `explain_why` defaults to OFF.** Opt-in via `summarize: true` per call. ✓
2. **LLM provider for narratives = Anthropic Claude Haiku 4.5 via `ANTHROPIC_API_KEY`.** No SDK dep — direct fetch. Fallback to OpenAI if `OPENAI_API_KEY` set. ✓
3. **Memories live in workspace root: `<workspace>/.qoneqt-mcp/memories/`.** This puts them in the user's repo so they're git-versionable and reviewable. Alt: `qoneqt-mcp/.qoneqt-mcp/<workspace>/memories/` (away from user repo). I'll go with **workspace-local**, gitignore-by-default; user can choose to commit. ✓
4. **AGENTS.md output: write to disk by default, or print-only?** Default: write to `<workspace>/AGENTS.md` AND `<workspace>/CLAUDE.md`. `--write false` returns content without writing. ✓
5. **`onboard()` is idempotent.** Default does NOT overwrite existing memory files; pass `force: true` to overwrite.

Default-yes to all five; speak up if any need change.
