#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./index/store.ts";
import { getDbPath, getWorkspaceRoot } from "./lib/paths.ts";
import { readFileTool, listFilesTool } from "./tools/read.ts";
import { outlineFileTool } from "./tools/outline.ts";
import { findSymbolTool, searchForPatternTool } from "./tools/search.ts";
import { statsTool, reindexTool } from "./tools/admin.ts";
import {
  listPagesTool,
  findPageTool,
  listApiRoutesTool,
} from "./tools/routes.ts";
import { findFetchesTool, findEndpointCallersTool } from "./tools/fetches.ts";
import { findContextUsageTool } from "./tools/context-usage.ts";
import { findSimilarComponentTool } from "./tools/similar.ts";
import { pickEmbeddingProvider, pickRerankProvider } from "./index/embeddings.ts";
import { startWatcher } from "./index/watcher.ts";
import { createMemoryStore } from "./lib/memory-store.ts";
import {
  listMemoriesTool,
  readMemoryTool,
  writeMemoryTool,
  deleteMemoryTool,
} from "./tools/memory.ts";
import { explainWhyTool } from "./tools/explain-why.ts";
import { onboardTool } from "./tools/onboard.ts";
import { generateAgentsMdTool } from "./tools/agents-md.ts";
import { pickLLMProvider } from "./lib/llm.ts";
import { createActivityLogger } from "./lib/activity-log.ts";
import {
  recentActivityTool,
  whoTouchedTool,
  whatDidUserDoTool,
} from "./tools/activity.ts";
import { installHooksTool, gitignoreTemplateTool } from "./tools/setup.ts";

const SYMBOL_KINDS = z.enum([
  "component",
  "function",
  "hook",
  "context",
  "class",
  "variable",
  "page",
  "api_route",
  "layout",
]);

async function main() {
  const workspace = getWorkspaceRoot();
  const dbPath = getDbPath(workspace);
  const store = new Store(dbPath);
  const embedder = pickEmbeddingProvider();
  const reranker = pickRerankProvider();
  const llm = pickLLMProvider();
  const memory = createMemoryStore(workspace);
  const activity = createActivityLogger({
    workspace,
    store,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  // Drain any git-event JSONL backlog that was emitted while we weren't running.
  await activity.flushPending().catch(() => {});

  const server = new McpServer(
    { name: "qoneqt-mcp", version: "0.4.0" },
    {
      instructions: buildInstructions({
        embedder: embedder?.name,
        reranker: reranker?.name,
        llm: llm?.name,
      }),
    },
  );

  // ===========================================================
  // Read & navigate
  // ===========================================================

  server.registerTool(
    "read_file",
    {
      description:
        "Read a file from the workspace with line-numbered output. Always bounded — defaults to 400 lines, max 2000. Pass start_line/end_line for specific ranges. Use outline_file first on large files.",
      inputSchema: {
        path: z.string().describe("Path relative to workspace root, e.g. src/app/home/page.js"),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        max_lines: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Cap on lines returned (default 400, hard max 2000)"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await readFileTool(workspace, args) }],
    }),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List files in the workspace matching a glob pattern. Default pattern: src/**/*.{js,jsx}. Use this before read_file when you don't know the exact path.",
      inputSchema: {
        pattern: z.string().optional(),
        max: z.number().int().positive().max(2000).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await listFilesTool(workspace, args) }],
    }),
  );

  server.registerTool(
    "outline_file",
    {
      description:
        "Get the symbol outline of a file (top-level components, functions, hooks, contexts, classes) with line ranges. Always call this before read_file on a file >300 lines.",
      inputSchema: { path: z.string() },
    },
    async (args) => ({
      content: [{ type: "text", text: outlineFileTool(store, args) }],
    }),
  );

  server.registerTool(
    "find_symbol",
    {
      description:
        "Find any symbol (component, function, hook, context, class, variable) by name. Returns file:line for each match. Faster and more precise than grep — use this first when you know the name.",
      inputSchema: {
        name: z.string(),
        kind: SYMBOL_KINDS.optional(),
        prefix: z.boolean().optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: findSymbolTool(store, args) }],
    }),
  );

  server.registerTool(
    "search_for_pattern",
    {
      description:
        "Regex search across the codebase via ripgrep (falls back to grep). Use as a fallback when find_symbol can't help — for string literals, JSX usage patterns, etc.",
      inputSchema: {
        pattern: z.string(),
        glob: z.string().optional(),
        max: z.number().int().positive().max(500).optional(),
        case_insensitive: z.boolean().optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await searchForPatternTool(workspace, args) }],
    }),
  );

  // ===========================================================
  // Routes (App Router)
  // ===========================================================

  server.registerTool(
    "list_pages",
    {
      description:
        "List Next.js App Router pages: route → file, optionally with layout chain. Filter by substring. v1 has ~167 pages.",
      inputSchema: {
        filter: z.string().optional().describe("Substring filter on the route, e.g. 'profile'"),
        show_layouts: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: listPagesTool(store, args) }],
    }),
  );

  server.registerTool(
    "find_page",
    {
      description:
        "Resolve an App Router route (e.g. '/profile/:id' or '/profile') to its page.js file plus the full layout chain.",
      inputSchema: {
        route: z.string().describe("Route to resolve, e.g. /profile/:id"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: findPageTool(store, args) }],
    }),
  );

  server.registerTool(
    "list_api_routes",
    {
      description:
        "List Next.js API endpoints under src/app/api with their HTTP methods (GET/POST/PUT/DELETE/PATCH).",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: listApiRoutesTool(store) }],
    }),
  );

  // ===========================================================
  // Fetches (the v1 data-layer map)
  // ===========================================================

  server.registerTool(
    "find_fetches",
    {
      description:
        "List fetch/axios call sites in the codebase. Pass `file` for a specific file or `glob` (e.g. 'src/app/profile/**'). Optionally filter by HTTP `method`. v1 has ~417 call sites; this is the primary tool for tracing the data layer.",
      inputSchema: {
        file: z.string().optional(),
        glob: z.string().optional(),
        method: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: findFetchesTool(store, args) }],
    }),
  );

  server.registerTool(
    "find_endpoint_callers",
    {
      description:
        "Given a backend endpoint (e.g. '/api/posts' or '/users/:id'), find every place in v1 that calls it. Substring match against URL templates. Use this BEFORE writing a new fetch — there's almost always an existing caller.",
      inputSchema: {
        url_pattern: z.string(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: findEndpointCallersTool(store, args) }],
    }),
  );

  // ===========================================================
  // Contexts
  // ===========================================================

  server.registerTool(
    "find_context_usage",
    {
      description:
        "For a React Context (e.g. 'AuthContext', 'FeedContext'), list the definition, the Provider, the consumer hook (useXxx), and every place each is mounted or consumed. v1 has 12+ contexts; this is the canonical tool for understanding state flow.",
      inputSchema: {
        name: z.string().describe("Exact context name, e.g. AuthContext"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: findContextUsageTool(store, args) }],
    }),
  );

  // ===========================================================
  // Similar component (SOTA hybrid retrieval)
  // ===========================================================

  server.registerTool(
    "find_similar_component",
    {
      description:
        "Hybrid (BM25 + dense embeddings + cross-encoder rerank) semantic search over v1 components and hooks. Best for natural-language queries like 'a settings tab with toggles' or 'an avatar with verified badge'. ALWAYS use this BEFORE writing a new component — there's almost always something similar already.",
      inputSchema: {
        query: z.string().describe("Natural-language description"),
        kind: z.enum(["component", "hook"]).optional(),
        top: z.number().int().positive().max(30).optional(),
        rerank: z
          .boolean()
          .optional()
          .describe("Apply cross-encoder rerank (default true if reranker available)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await findSimilarComponentTool(
            { store, embedder, reranker },
            args,
          ),
        },
      ],
    }),
  );

  // ===========================================================
  // Memory
  // ===========================================================

  server.registerTool(
    "list_memories",
    {
      description:
        "List all persistent memory files (markdown notes about the project). ALWAYS call this at the start of a session.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: await listMemoriesTool(memory) }],
    }),
  );

  server.registerTool(
    "read_memory",
    {
      description:
        "Read a memory file. Reserved files: _index, architecture, conventions, commands, gotchas, glossary. ALWAYS read _index first.",
      inputSchema: {
        name: z.string().describe("Memory name (no .md), e.g. 'architecture' or '_index'"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await readMemoryTool(memory, args) }],
    }),
  );

  server.registerTool(
    "write_memory",
    {
      description:
        "Write or replace a memory file (markdown + YAML frontmatter). Use sparingly — only for genuinely persistent project knowledge (architecture, conventions, gotchas, glossary). Default refuses to overwrite; pass overwrite=true to replace.",
      inputSchema: {
        name: z.string(),
        body: z.string().describe("Markdown body (no frontmatter — frontmatter is generated)"),
        title: z.string().optional(),
        scope: z.string().optional(),
        status: z.enum(["stable", "drifting", "deprecated"]).optional(),
        related: z.array(z.string()).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await writeMemoryTool(memory, args) }],
    }),
  );

  server.registerTool(
    "delete_memory",
    {
      description: "Delete a memory file (rare — usually deprecate by setting status=deprecated).",
      inputSchema: { name: z.string() },
    },
    async (args) => ({
      content: [{ type: "text", text: await deleteMemoryTool(memory, args) }],
    }),
  );

  // ===========================================================
  // explain_why
  // ===========================================================

  server.registerTool(
    "explain_why",
    {
      description:
        "Explain WHY a piece of code exists, not what it does. Pulls git blame, commit messages, linked PRs + issues (via gh CLI / GITHUB_TOKEN), nearby comments, TODO/FIXME markers, and ADRs. Pass `summarize: true` for an LLM-generated narrative (requires ANTHROPIC_API_KEY or OPENAI_API_KEY).",
      inputSchema: {
        path: z.string().optional().describe("Path relative to workspace; pair with line_range for surgical scope."),
        symbol: z.string().optional().describe("Symbol name; resolved via the index to its file + lines."),
        line_range: z
          .object({ start: z.number().int().positive(), end: z.number().int().positive() })
          .optional(),
        summarize: z.boolean().optional().describe("Default false. Opt-in LLM narrative (deterministic when off)."),
        max_commits: z.number().int().positive().max(8).optional(),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await explainWhyTool({ workspace, store, llm }, args),
        },
      ],
    }),
  );

  // ===========================================================
  // Onboarding & meta
  // ===========================================================

  server.registerTool(
    "onboard",
    {
      description:
        "Bootstrap the memory scaffold (architecture / conventions / commands / gotchas / glossary / _index) from the indexed codebase. Idempotent: skips existing files unless force=true. Run this once per workspace, then edit the TODO sections.",
      inputSchema: {
        force: z.boolean().optional().describe("Overwrite existing memory files."),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await onboardTool({ workspace, store, memory }, args),
        },
      ],
    }),
  );

  server.registerTool(
    "generate_agents_md",
    {
      description:
        "Generate AGENTS.md (and a CLAUDE.md symlink) at the workspace root. Auto-fills mechanical sections (project identity, commands, MCP tool routing table, conventions, pointers); leaves judgement sections as TODO. Per Vercel + ETH Zurich evals — concise routing > prose overviews.",
      inputSchema: {
        write: z.boolean().optional().describe("Default true. Pass false for dry-run."),
        target: z.string().optional().describe("Defaults to workspace root."),
        symlink_claude: z.boolean().optional().describe("Default true. Symlinks CLAUDE.md → AGENTS.md so Claude Code picks it up."),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await generateAgentsMdTool({ workspace, store }, args),
        },
      ],
    }),
  );

  // ===========================================================
  // Activity log (who-changed-what)
  // ===========================================================

  server.registerTool(
    "recent_activity",
    {
      description:
        "Show recent file activity (who changed what, when). Source values: watcher (live edits), commit (git commits), merge (git pulls/merges), checkout (branch switches). Filter by user / file substring / source / since_days.",
      inputSchema: {
        user: z.string().optional(),
        file: z.string().optional().describe("Substring match on file_path"),
        source: z
          .enum(["watcher", "commit", "merge", "checkout", "rebase", "manual"])
          .optional(),
        since_days: z.number().int().positive().max(365).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: recentActivityTool(store, args) }],
    }),
  );

  server.registerTool(
    "who_touched",
    {
      description:
        "Who has touched a specific file recently? Aggregates from the activity log (watcher + git hooks). Returns top contributors with action counts.",
      inputSchema: {
        file: z.string().describe("Workspace-relative file path"),
        since_days: z.number().int().positive().max(365).optional().describe("Default 90"),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: whoTouchedTool(store, args) }],
    }),
  );

  server.registerTool(
    "what_did_user_do",
    {
      description:
        "What files has a specific dev been touching? Useful when onboarding new agents or asking 'what is X working on?'.",
      inputSchema: {
        user: z.string().describe("Git user.name (e.g. 'yrevash')"),
        since_days: z.number().int().positive().max(365).optional().describe("Default 14"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: whatDidUserDoTool(store, args) }],
    }),
  );

  // ===========================================================
  // Setup helpers (install git hooks, gitignore template)
  // ===========================================================

  server.registerTool(
    "install_hooks",
    {
      description:
        "Install qoneqt-mcp git hooks (post-commit, post-merge, post-checkout) into the workspace's .git/hooks/. Backs up any pre-existing hooks once. Idempotent. After installation, every git operation in the workspace logs to the activity table with the local git user as actor.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: await installHooksTool({ workspace }) }],
    }),
  );

  server.registerTool(
    "gitignore_template",
    {
      description:
        "Print the recommended .gitignore block for a workspace using qoneqt-mcp. Tells you what to ignore (local index, event log) vs. commit (memories/).",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: gitignoreTemplateTool() }],
    }),
  );

  // ===========================================================
  // Admin
  // ===========================================================

  server.registerTool(
    "stats",
    {
      description: "Show indexer stats. Diagnostic.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: statsTool(store) }],
    }),
  );

  server.registerTool(
    "reindex",
    {
      description:
        "Force a full reindex (parsing + app router + embeddings if configured). ~15s for v1.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: await reindexTool(workspace) }],
    }),
  );

  // ===========================================================
  // File watcher — auto-reindex on save
  // ===========================================================

  const watcher = startWatcher({
    workspace,
    store,
    embedder,
    activity,
    log: (msg) => process.stderr.write(`${msg}\n`),
  });

  // Graceful shutdown
  const shutdown = async () => {
    await watcher.stop();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function buildInstructions(opts: {
  embedder?: string | undefined;
  reranker?: string | undefined;
  llm?: string | undefined;
}): string {
  const stack = [
    opts.embedder ? `dense=${opts.embedder}` : "dense=disabled",
    opts.reranker ? `rerank=${opts.reranker}` : "rerank=disabled",
    opts.llm ? `llm=${opts.llm}` : "llm=disabled",
  ].join(" ");
  return `Qoneqt v1 codebase context (Next.js 15, JS+JSX, ~647 files). Stack: ${stack}.

ON SESSION START:
  1. list_memories  — see what's already known about this codebase
  2. read_memory _index  — index of all memories
  3. read_memory architecture (or other memories on demand)

DURING WORK (priority order):
  1. find_symbol  — exact name lookup; faster + more precise than grep
  2. find_similar_component  — natural-language matching ("a card with avatar")
  3. find_endpoint_callers  — BEFORE writing a fetch, see who already calls that endpoint
  4. find_context_usage  — for Auth/Feed/Kyc/Profile/Message/Toast state flow
  5. list_pages / find_page  — App Router navigation
  6. outline_file then read_file(start_line, end_line)  — for files >300 lines
  7. explain_why  — to understand the rationale behind a piece of code (blame + PR + issues + comments + ADRs)
  8. search_for_pattern  — regex fallback only when symbols/contexts/fetches don't help

NEVER read whole large files. v1 has 7K–13K-line monoliths (Icons.jsx, walter_white admin pages); always outline first.

WHEN TO write_memory:
  - User corrected an assumption: "no, we do X here"
  - You re-discovered the same gotcha twice
  - End of a meaningful change with new architectural context worth preserving
  Don't write memory for things the linter, typechecker, or git history already records.`;
}

main().catch((err) => {
  console.error("[qoneqt-mcp] fatal:", err);
  process.exit(1);
});
