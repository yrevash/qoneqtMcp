import type { Store } from "../index/store.ts";
import type { FetchRow } from "../lib/types.ts";

export function findFetchesTool(
  store: Store,
  args: { file?: string; glob?: string; method?: string; limit?: number },
): string {
  let rows: FetchRow[];

  if (args.file) {
    rows = store.fetchesInFile(args.file);
  } else if (args.glob) {
    // Convert simple glob like "src/app/**" into a SQL LIKE pattern.
    const like = globToLike(args.glob);
    rows = store.fetchesByGlob(like);
  } else {
    rows = store.fetchesByGlob("%");
  }

  if (args.method) {
    const m = args.method.toUpperCase();
    rows = rows.filter((r) => r.method === m);
  }

  const limit = Math.min(args.limit ?? 100, 500);
  const shown = rows.slice(0, limit);

  return formatFetchRows(shown, rows.length, limit, scope(args));
}

export function findEndpointCallersTool(
  store: Store,
  args: { url_pattern: string; limit?: number },
): string {
  const limit = Math.min(args.limit ?? 100, 500);
  const rows = store.fetchesByEndpoint(args.url_pattern, limit + 1);
  const truncated = rows.length > limit;
  const shown = rows.slice(0, limit);
  return formatFetchRows(
    shown,
    rows.length,
    limit,
    `endpoint matching "${args.url_pattern}"`,
    truncated,
  );
}

function formatFetchRows(
  rows: FetchRow[],
  total: number,
  limit: number,
  scopeStr: string,
  truncated = total > limit,
): string {
  if (rows.length === 0) {
    return `no fetches found for ${scopeStr}.`;
  }

  const groups = new Map<string, FetchRow[]>();
  for (const r of rows) {
    const list = groups.get(r.file_path) ?? [];
    list.push(r);
    groups.set(r.file_path, list);
  }

  const lines = [
    `${scopeStr}: ${total} call site(s)${truncated ? ` (showing first ${limit})` : ""}`,
  ];
  for (const [path, list] of groups) {
    lines.push(`\n${path}`);
    for (const r of list) lines.push(formatFetch(r));
  }
  return lines.join("\n");
}

function formatFetch(r: FetchRow): string {
  const url = r.url_template ?? `(${r.url_raw})`;
  const tags: string[] = [];
  if (r.is_dynamic) tags.push("dyn");
  if (r.has_auth) tags.push("auth");
  const tagPart = tags.length ? `  [${tags.join(",")}]` : "";
  return `  L${String(r.start_line).padStart(4, " ")}  ${(r.method ?? "?").padEnd(6)} ${url}${tagPart}  via ${r.callee}`;
}

function scope(args: { file?: string; glob?: string; method?: string }): string {
  const parts: string[] = [];
  if (args.file) parts.push(`file=${args.file}`);
  if (args.glob) parts.push(`glob=${args.glob}`);
  if (args.method) parts.push(`method=${args.method.toUpperCase()}`);
  return parts.length ? parts.join(" ") : "all files";
}

function globToLike(g: string): string {
  // Naive but useful for our use-cases:
  //   "src/app/**"  → "src/app/%"
  //   "src/app/*"   → "src/app/%"
  //   "src/app/foo" → "src/app/foo"
  return g.replace(/\*\*/g, "%").replace(/\*/g, "%");
}
