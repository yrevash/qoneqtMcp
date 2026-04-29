import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Store } from "../index/store.ts";
import type { MemoryStore } from "../lib/memory-store.ts";
import { getWorkspacePackageJson } from "../lib/paths.ts";

export interface OnboardOpts {
  workspace: string;
  store: Store;
  memory: MemoryStore;
}

export async function onboardTool(
  ctx: OnboardOpts,
  args: { force?: boolean },
): Promise<string> {
  const force = args.force === true;
  const written: string[] = [];
  const skipped: string[] = [];
  const tasks = await collectFacts(ctx);

  // architecture.md
  await writeIfAllowed(
    ctx.memory,
    "architecture",
    {
      title: "Architecture",
      scope: "*",
      status: "stable",
      related: ["conventions", "commands"],
    },
    renderArchitecture(tasks),
    force,
    written,
    skipped,
  );

  // commands.md (fully auto from package.json)
  await writeIfAllowed(
    ctx.memory,
    "commands",
    {
      title: "Commands",
      scope: "*",
      status: "stable",
    },
    renderCommands(tasks),
    force,
    written,
    skipped,
  );

  // conventions.md (seeded from index)
  await writeIfAllowed(
    ctx.memory,
    "conventions",
    {
      title: "Conventions",
      scope: "*",
      status: "drifting",
      related: ["architecture"],
    },
    renderConventions(tasks),
    force,
    written,
    skipped,
  );

  // gotchas.md (stub with TODO)
  await writeIfAllowed(
    ctx.memory,
    "gotchas",
    {
      title: "Gotchas",
      scope: "*",
      status: "drifting",
    },
    renderGotchasStub(tasks),
    force,
    written,
    skipped,
  );

  // glossary.md (stub with TODO)
  await writeIfAllowed(
    ctx.memory,
    "glossary",
    {
      title: "Glossary",
      scope: "*",
      status: "drifting",
    },
    renderGlossaryStub(),
    force,
    written,
    skipped,
  );

  // _index.md (rewrite-always; lists all memories)
  const all = await ctx.memory.list();
  await ctx.memory.write(
    "_index",
    renderIndex(all),
    {
      title: "Memory Index",
      scope: "*",
      status: "stable",
    },
  );
  written.push("_index");

  const lines = [
    `onboard complete.  written: ${written.length}, skipped: ${skipped.length}`,
    `dir: ${ctx.memory.dir}`,
    "",
  ];
  if (written.length) lines.push(`written:  ${written.join(", ")}`);
  if (skipped.length) lines.push(`skipped:  ${skipped.join(", ")} (already exist; pass force:true to overwrite)`);
  lines.push("");
  lines.push("next steps:");
  lines.push("  1. read each memory and edit the <!-- TODO --> sections with v1-specific knowledge");
  lines.push("  2. run generate_agents_md to write the AGENTS.md / CLAUDE.md bootstrap at the workspace root");
  return lines.join("\n");
}

async function writeIfAllowed(
  memory: MemoryStore,
  name: string,
  fm: Record<string, unknown>,
  body: string,
  force: boolean,
  written: string[],
  skipped: string[],
) {
  if (!force && (await memory.exists(name))) {
    skipped.push(name);
    return;
  }
  await memory.write(name, body, fm);
  written.push(name);
}

// =====================================================
// Fact collection
// =====================================================

interface Facts {
  workspace: string;
  pkg: PackageJson | null;
  topDirs: string[];
  contexts: string[];
  dataLayer: { fetchTotal: number; methodCounts: Record<string, number>; topEndpoints: string[] };
  pageCount: number;
  apiRouteCount: number;
  totalSymbols: number;
  totalFiles: number;
}

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function collectFacts(ctx: OnboardOpts): Promise<Facts> {
  const pkg = await readPackageJson(ctx.workspace);

  // contexts: any symbol of kind="context"
  const contexts = ctx.store
    .findSymbolsByPrefix("", "context", 200)
    .map((s) => s.name)
    .sort();

  // pages / api routes counts
  const pageCount = ctx.store.allPages().length;
  const apiRouteCount = ctx.store.allApiRoutes().length;

  // data layer: pull all fetches
  const fetches = ctx.store.fetchesByGlob("%");
  const methodCounts: Record<string, number> = {};
  const endpointFreq = new Map<string, number>();
  for (const f of fetches) {
    methodCounts[f.method ?? "?"] = (methodCounts[f.method ?? "?"] ?? 0) + 1;
    if (f.url_template) {
      const stem = stemEndpoint(f.url_template);
      endpointFreq.set(stem, (endpointFreq.get(stem) ?? 0) + 1);
    }
  }
  const topEndpoints = [...endpointFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([s, n]) => `${s}  (${n})`);

  // top dirs under src
  const topDirs = await listTopSrcDirs(ctx.workspace);

  // overall stats
  const stats = ctx.store.stats();

  return {
    workspace: ctx.workspace,
    pkg,
    topDirs,
    contexts,
    dataLayer: { fetchTotal: fetches.length, methodCounts, topEndpoints },
    pageCount,
    apiRouteCount,
    totalSymbols: stats.symbols,
    totalFiles: stats.files,
  };
}

async function readPackageJson(workspace: string): Promise<PackageJson | null> {
  try {
    const text = await readFile(getWorkspacePackageJson(workspace), "utf8");
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

async function listTopSrcDirs(workspace: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  try {
    const entries = await readdir(resolve(workspace, "src"));
    const out: string[] = [];
    for (const e of entries) {
      const s = await stat(resolve(workspace, "src", e)).catch(() => null);
      if (s?.isDirectory()) out.push(e);
    }
    return out.sort();
  } catch {
    return [];
  }
}

function stemEndpoint(template: string): string {
  // Trim trailing dynamic segments to capture a "family", e.g.
  // "/golang/api/metadata/post/:id" → "/golang/api/metadata/post"
  return template.replace(/\/(:[\w?]+|\*\w+\??)+$/g, "");
}

function detectFramework(pkg: PackageJson | null): {
  framework: string;
  version: string;
  router: string;
} {
  if (!pkg) return { framework: "unknown", version: "?", router: "?" };
  const next = pkg.dependencies?.next ?? pkg.devDependencies?.next ?? null;
  if (next) {
    return {
      framework: "Next.js",
      version: next.replace(/^[^\d]+/, ""),
      router: "App Router",
    };
  }
  const vite = pkg.dependencies?.vite ?? pkg.devDependencies?.vite ?? null;
  if (vite) {
    return { framework: "Vite + React", version: vite.replace(/^[^\d]+/, ""), router: "react-router" };
  }
  return { framework: "unknown", version: "?", router: "?" };
}

// =====================================================
// Renderers
// =====================================================

function renderArchitecture(facts: Facts): string {
  const fw = detectFramework(facts.pkg);
  const lines = [
    `# Architecture`,
    "",
    `**Stack:** ${fw.framework} ${fw.version}, JavaScript, ${fw.router}.`,
    "",
    "## Top-level layout",
    "",
    facts.topDirs.length
      ? facts.topDirs.map((d) => `- \`src/${d}/\``).join("\n")
      : "- (no src/ subdirectories detected)",
    "",
    `## Scale`,
    "",
    `- ${facts.totalFiles} indexed files, ${facts.totalSymbols} top-level symbols.`,
    `- ${facts.pageCount} App Router pages, ${facts.apiRouteCount} API routes.`,
    `- ${facts.dataLayer.fetchTotal} fetch / axios call sites across the codebase.`,
    "",
    "## State management",
    "",
    facts.contexts.length
      ? `Uses React Context API. The following contexts exist:\n\n${facts.contexts.map((c) => `- \`${c}\``).join("\n")}`
      : "No React Contexts detected. State management approach: <!-- TODO: document -->.",
    "",
    "Use the \`find_context_usage\` MCP tool to see Provider mount points and consumers for any of these.",
    "",
    "## Data layer",
    "",
    facts.dataLayer.fetchTotal > 0
      ? renderDataLayerSection(facts.dataLayer)
      : "<!-- TODO: describe how this codebase fetches data -->",
    "",
    "## Why this architecture",
    "",
    "<!-- TODO: capture the rationale behind major architectural choices.",
    "  Example: 'we use React Context not Redux because X', 'Go backend instead of Node because Y',",
    "  'App Router not Pages Router because Z'. -->",
    "",
  ];
  return lines.join("\n");
}

function renderDataLayerSection(d: Facts["dataLayer"]): string {
  const methodSummary = Object.entries(d.methodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}=${n}`)
    .join("  ");
  const lines = [
    `- ${d.fetchTotal} fetch/axios sites total. Methods:  ${methodSummary}`,
    "",
    "Most-called endpoint stems (use \`find_endpoint_callers\` to find every caller):",
    "",
    ...d.topEndpoints.slice(0, 10).map((e) => `- \`${e}\``),
    "",
    "<!-- TODO: name the canonical fetch wrapper or rule. e.g. 'all internal calls go through src/utils/api.js'. -->",
  ];
  return lines.join("\n");
}

function renderCommands(facts: Facts): string {
  const scripts = facts.pkg?.scripts ?? {};
  const lines = [
    "# Commands",
    "",
    "All commands run from the workspace root.",
    "",
    "## Package scripts",
    "",
  ];
  if (Object.keys(scripts).length === 0) {
    lines.push("(no scripts in package.json)");
  } else {
    for (const [k, v] of Object.entries(scripts)) {
      lines.push(`- \`bun run ${k}\` — \`${v}\``);
    }
  }
  lines.push("");
  lines.push("## Other");
  lines.push("");
  lines.push("- `bun install` — install dependencies");
  lines.push("");
  lines.push("<!-- TODO: add deploy / migrate / lint-fix / one-off scripts here. -->");
  return lines.join("\n");
}

function renderConventions(facts: Facts): string {
  const fw = detectFramework(facts.pkg);
  const lines = [
    "# Conventions",
    "",
    "## Routing",
    "",
    fw.framework === "Next.js"
      ? "- File-system routing under `src/app/**/page.{js,jsx}`. Use `find_page` and `list_pages` to navigate, NOT grep.\n- Layouts compose via `src/app/**/layout.{js,jsx}`."
      : "<!-- TODO: describe routing convention -->",
    "",
    "## Data fetching",
    "",
    facts.dataLayer.fetchTotal > 0
      ? "- Direct `fetch()` calls are the dominant pattern. Before writing a new one, ALWAYS run `find_endpoint_callers` to check for existing callers — there is almost always one.\n- Template literals like `` `${BASE}/api/...` `` are normalized in the index as `:base/api/...`."
      : "<!-- TODO: describe how data is fetched -->",
    "",
    "## State",
    "",
    facts.contexts.length
      ? `- React Context API. The ${facts.contexts.length} contexts are listed in \`architecture.md\`. Each typically exports a \`<Name>Provider\` component and a \`use<Name>\` consumer hook. Use \`find_context_usage\` to see mount points and consumers.`
      : "<!-- TODO: describe state management convention -->",
    "",
    "## Components",
    "",
    "- React function components in `.jsx`. Component names UpperCamelCase; hook names `use<Name>`.",
    "- BEFORE writing a new component, call `find_similar_component` with a natural-language description. There is almost always one.",
    "",
    "## Imports",
    "",
    "- `@/*` resolves to `./src/*` (see `jsconfig.json`).",
    "- Prefer the alias over deep relative paths.",
    "",
    "## What linter/typechecker enforces (skip in this file)",
    "",
    "<!-- Don't repeat eslint/prettier rules here; the linter is the source of truth. -->",
    "",
    "## Anti-patterns",
    "",
    "<!-- TODO: capture 'we tried X and abandoned it', 'don't reach for Y because Z'. -->",
    "",
  ];
  return lines.join("\n");
}

function renderGotchasStub(_facts: Facts): string {
  return [
    "# Gotchas",
    "",
    "Failure modes that bit us, with the workaround. Add an entry only after the **second** time the same confusion happens.",
    "",
    "<!-- TODO:",
    "  ## Title",
    "  **Symptom:** what you see",
    "  **Cause:** why it happens",
    "  **Fix:** the workaround",
    "  **Related:** PR #X / commit abc123",
    "-->",
    "",
  ].join("\n");
}

function renderGlossaryStub(): string {
  return [
    "# Glossary",
    "",
    "Domain terms that an outsider (or AI agent) would not infer from the code.",
    "",
    "<!-- TODO: e.g.",
    "  - **walter_white** — the admin section. Not a person.",
    "  - **KYC** — Know Your Customer; identity verification flow.",
    "  - **Verified Tick** — blue-tick badge granted after multi-step verification.",
    "-->",
    "",
  ].join("\n");
}

function renderIndex(memories: { name: string; frontmatter: { title?: string } }[]): string {
  const lines = [
    "# Memory Index",
    "",
    "Read this first. Each entry below is a markdown memory file that the agent can read with `read_memory`.",
    "",
  ];
  for (const m of memories) {
    if (m.name === "_index") continue;
    const title = m.frontmatter.title ?? m.name;
    lines.push(`- **${m.name}** — ${title}`);
  }
  lines.push("");
  lines.push(
    "Memories are markdown files in `.qoneqt-mcp/memories/`. They are intended to be human-edited and (optionally) committed to the repo for review.",
  );
  return lines.join("\n");
}
