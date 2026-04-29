import { readFile, writeFile, symlink, unlink, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Store } from "../index/store.ts";
import { getWorkspacePackageJson } from "../lib/paths.ts";

export interface AgentsMdOpts {
  workspace: string;
  store: Store;
}

export async function generateAgentsMdTool(
  ctx: AgentsMdOpts,
  args: { write?: boolean; target?: string; symlink_claude?: boolean },
): Promise<string> {
  const target = args.target ?? ctx.workspace;
  const writeIt = args.write !== false;

  const content = await renderAgentsMd(ctx);

  if (!writeIt) {
    return [
      `(dry-run; not written)`,
      `target: ${target}/AGENTS.md`,
      `bytes: ${content.length}`,
      "",
      content,
    ].join("\n");
  }

  const agentsPath = resolve(target, "AGENTS.md");
  const claudePath = resolve(target, "CLAUDE.md");

  await writeFile(agentsPath, content, "utf8");

  // Claude Code reads CLAUDE.md, not AGENTS.md (Issue #6235). Symlink unless caller opts out.
  let claudeNote = "";
  if (args.symlink_claude !== false) {
    try {
      // Replace if it exists.
      try {
        await stat(claudePath);
        await unlink(claudePath);
      } catch {}
      await symlink("AGENTS.md", claudePath);
      claudeNote = "  symlink: CLAUDE.md → AGENTS.md (so Claude Code picks it up)";
    } catch (err) {
      // Fallback: write a copy.
      try {
        await writeFile(claudePath, content, "utf8");
        claudeNote = "  copy:    CLAUDE.md (symlink failed; wrote a copy instead)";
      } catch (err2) {
        claudeNote = `  failed to write CLAUDE.md: ${(err2 as Error).message}`;
      }
    }
  }

  return [
    `wrote AGENTS.md to ${agentsPath}  (${content.length} bytes)`,
    claudeNote,
    "",
    "review the <!-- TODO --> blocks and replace with v1-specific judgement (anti-patterns, allowed/ask/never).",
  ].join("\n");
}

async function renderAgentsMd(ctx: AgentsMdOpts): Promise<string> {
  const pkg = await readPkg(ctx.workspace);
  const fw = detectFramework(pkg);
  const stats = ctx.store.stats();
  const contexts = ctx.store.findSymbolsByPrefix("", "context", 50).map((s) => s.name);

  const scripts = pkg?.scripts ?? {};
  const scriptLines = Object.entries(scripts)
    .map(([k, v]) => `- \`bun run ${k}\` — \`${v}\``)
    .join("\n");

  // Identify pointers (any /docs markdown).
  const pointers = await collectDocPointers(ctx.workspace);

  return [
    `# AGENTS.md — ${pkg?.name ?? "this repo"}`,
    "",
    `**Stack:** ${fw.framework} ${fw.version}. **Language:** JavaScript (no TypeScript). **Router:** ${fw.router}.`,
    `**Indexed:** ${stats.files} files, ${stats.symbols} symbols, ${stats.fetches} fetch sites, ${stats.pages} pages, ${stats.apiRoutes} API routes.`,
    "",
    "## You MUST use the qoneqt-mcp tools",
    "",
    "Before reaching for grep, file-tree exploration, or guessing — invoke the right MCP tool. Decision rules:",
    "",
    "| When you need to… | Use this tool | NOT |",
    "| --- | --- | --- |",
    "| Find a component, function, hook, context by name | `find_symbol` | grep |",
    "| Find natural-language match for a component idea | `find_similar_component` | reading files |",
    "| See an existing page's file + layout chain | `find_page` (or `list_pages`) | walking `src/app/` |",
    "| Find every caller of a backend endpoint | `find_endpoint_callers` | grepping for `fetch(` |",
    "| List `fetch` calls in a specific file or area | `find_fetches` | reading the file |",
    "| Know how a Context flows | `find_context_usage` | reading the Provider |",
    "| Read a file >300 lines | `outline_file` then `read_file(start_line, end_line)` | reading the whole file |",
    "| Understand WHY a piece of code exists | `explain_why` | guessing from the diff |",
    "| Find a regex / string literal | `search_for_pattern` | (this is the only valid grep substitute) |",
    "",
    "**ALWAYS call `list_memories` and `read_memory _index` at the start of a session.** Project knowledge lives there.",
    "",
    "## Project shape",
    "",
    `- File-system routing in \`src/app/**/page.{js,jsx}\`. ${stats.pages} routes; use \`list_pages\` or \`find_page\`.`,
    `- API endpoints in \`src/app/api/**/route.{js,jsx}\`. ${stats.apiRoutes} routes; use \`list_api_routes\`.`,
    `- React Context API for state: ${contexts.length ? contexts.map((c) => "`" + c + "`").join(", ") : "(none indexed)"}. Use \`find_context_usage\`.`,
    `- Path alias: \`@/*\` → \`./src/*\` (see \`jsconfig.json\`). PREFER the alias over relative paths.`,
    "",
    "## Commands",
    "",
    scriptLines || "(no scripts found in package.json)",
    "- `bun install` — install dependencies",
    "",
    "## Conventions agents won't infer",
    "",
    "- Direct `fetch()` is the canonical data layer (despite Apollo / GraphQL / Supabase being installed). BEFORE writing a fetch, run `find_endpoint_callers` against the URL pattern.",
    "- Component names UpperCamelCase; hook names `useXxx`; context values are React Context API instances exported alongside a Provider component and a consumer hook.",
    "- The admin section lives under `src/app/walter_white/**`. Treat it as a separate scope.",
    "- Some files are deliberately huge (`src/components/common/Icons.jsx` ~13K lines) and are skipped by the indexer. Read them only by line range.",
    "",
    "## Anti-patterns",
    "",
    "<!-- TODO: list things that look right but are wrong here. e.g.",
    "  - DO NOT introduce TypeScript files; v1 is JS-only.",
    "  - DO NOT add a global state library; we use Context API by convention.",
    "  - DO NOT write a fetch wrapper; we use direct fetch + custom auth headers per call.",
    "-->",
    "",
    "## Allowed / Ask First / Never",
    "",
    "<!-- TODO: explicit boundaries. e.g.",
    "  - Allowed: edit any component / page / hook with passing tests.",
    "  - Ask first: changing src/middleware.js, src/instrumentation.js, src/contexts/AuthContext.js.",
    "  - Never: commit secrets; run scripts/destroy-*; modify the golang-backend/ from the frontend repo.",
    "-->",
    "",
    "## Pointers",
    "",
    pointers.length
      ? pointers.map((p) => `- \`@${p}\``).join("\n")
      : "(no `/docs` directory found — ignore this section.)",
    "",
    "## On every session",
    "",
    "1. `list_memories` — see what's already known.",
    "2. `read_memory _index` — table of contents.",
    "3. Re-run `reindex` if you suspect the index is stale (large rebase / branch switch).",
    "",
    "---",
    "",
    "*Generated by qoneqt-mcp `generate_agents_md`. The TODO sections are intentionally left for humans — auto-generated prose actively hurts agent performance (per Vercel + ETH Zurich evals, Jan–Feb 2026). Keep this file under 200 lines.*",
    "",
  ].join("\n");
}

async function readPkg(workspace: string): Promise<{
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null> {
  try {
    const text = await readFile(getWorkspacePackageJson(workspace), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function detectFramework(
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null,
) {
  if (!pkg) return { framework: "unknown", version: "?", router: "?" };
  const next = pkg.dependencies?.next ?? pkg.devDependencies?.next ?? null;
  if (next) {
    return {
      framework: "Next.js",
      version: next.replace(/^[^\d]+/, ""),
      router: "App Router",
    };
  }
  return { framework: "unknown", version: "?", router: "?" };
}

async function collectDocPointers(workspace: string): Promise<string[]> {
  const { Glob } = await import("bun");
  const out: string[] = [];
  const glob = new Glob("docs/**/*.md");
  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    out.push(rel);
    if (out.length >= 20) break;
  }
  return out.sort();
}
