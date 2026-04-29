import type { Store } from "../index/store.ts";
import { formatSymbolRow } from "./outline.ts";
import { spawn } from "bun";

const VALID_KINDS = [
  "component",
  "function",
  "hook",
  "context",
  "class",
  "variable",
  "page",
  "api_route",
  "layout",
];

export function findSymbolTool(
  store: Store,
  args: { name: string; kind?: string; prefix?: boolean },
): string {
  const kind = args.kind && VALID_KINDS.includes(args.kind) ? args.kind : undefined;
  const rows = args.prefix
    ? store.findSymbolsByPrefix(args.name, kind)
    : store.findSymbolsByName(args.name, kind);

  if (rows.length === 0) {
    const hint = args.prefix
      ? ""
      : "\n(try prefix=true to match by prefix, or check spelling)";
    return `no symbol matches: name="${args.name}"${kind ? ` kind=${kind}` : ""}${hint}`;
  }

  const lines = [
    `find_symbol "${args.name}"${kind ? ` (kind=${kind})` : ""} — ${rows.length} match(es)`,
  ];
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = grouped.get(r.file_path) ?? [];
    list.push(r);
    grouped.set(r.file_path, list);
  }
  for (const [path, list] of grouped) {
    lines.push(`\n${path}`);
    for (const r of list) lines.push(formatSymbolRow(r));
  }
  return lines.join("\n");
}

export async function searchForPatternTool(
  workspace: string,
  args: { pattern: string; glob?: string; max?: number; case_insensitive?: boolean },
): Promise<string> {
  const max = Math.min(args.max ?? 100, 500);
  const usingRg = Bun.which("rg") != null;

  const cmd = usingRg
    ? buildRipgrepCmd(args)
    : Bun.which("grep")
      ? buildGrepCmd(args)
      : null;

  if (!cmd) {
    return "search_for_pattern requires ripgrep or grep on PATH; neither found.";
  }

  const proc = spawn(cmd, {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code === 1 && !stdout.trim()) {
    return `no matches for pattern: ${args.pattern}`;
  }
  if (code !== 0 && code !== 1) {
    return `${usingRg ? "ripgrep" : "grep"} error (exit ${code}): ${stderr.trim() || "unknown"}`;
  }

  const allLines = stdout.split("\n").filter(Boolean);
  const truncated = allLines.length > max;
  const lines = allLines.slice(0, max);

  return `pattern: ${args.pattern}\nbackend: ${usingRg ? "ripgrep" : "grep"}\nmatches: ${allLines.length}${truncated ? " (truncated)" : ""}\n\n${lines.join("\n")}`;
}

function buildRipgrepCmd(args: {
  pattern: string;
  glob?: string;
  case_insensitive?: boolean;
}): string[] {
  return [
    "rg",
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count",
    "10",
    ...(args.case_insensitive ? ["-i"] : []),
    ...(args.glob ? ["-g", args.glob] : ["-g", "src/**/*.{js,jsx}"]),
    "-e",
    args.pattern,
  ];
}

function buildGrepCmd(args: {
  pattern: string;
  glob?: string;
  case_insensitive?: boolean;
}): string[] {
  // Default to JS/JSX in src/. If a custom glob is given, derive --include from its tail.
  const includes: string[] = [];
  if (args.glob) {
    // Take the file portion after the last '/'. e.g. 'src/contexts/*.js' → '*.js'.
    const tail = args.glob.split("/").pop() ?? "*";
    includes.push(`--include=${tail}`);
  } else {
    includes.push("--include=*.js", "--include=*.jsx");
  }
  return [
    "grep",
    "-rEnH",
    "--color=never",
    ...(args.case_insensitive ? ["-i"] : []),
    ...includes,
    "-m",
    "10",
    args.pattern,
    "src",
  ];
}
