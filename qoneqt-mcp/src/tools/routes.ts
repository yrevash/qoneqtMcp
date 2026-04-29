import type { Store } from "../index/store.ts";

export function listPagesTool(
  store: Store,
  args: { filter?: string; show_layouts?: boolean; limit?: number },
): string {
  const all = store.allPages();
  const filtered = args.filter
    ? all.filter((p) => p.route.includes(args.filter!))
    : all;
  const limit = Math.min(args.limit ?? 200, 1000);
  const shown = filtered.slice(0, limit);

  const lines = [
    `pages: ${filtered.length}${filtered.length > limit ? ` (showing first ${limit})` : ""}` +
      (args.filter ? ` matching "${args.filter}"` : ""),
    "",
  ];
  for (const p of shown) {
    const tags = [
      p.is_dynamic ? "dynamic" : "",
      p.is_route_group ? "in-group" : "",
    ]
      .filter(Boolean)
      .join(",");
    const tagPart = tags ? ` [${tags}]` : "";
    lines.push(`  ${p.route.padEnd(48)} → ${p.file_path}${tagPart}`);
    if (args.show_layouts && p.layout_chain) {
      lines.push(`      layouts: ${p.layout_chain}`);
    }
  }
  return lines.join("\n");
}

export function findPageTool(
  store: Store,
  args: { route: string },
): string {
  // Try exact match first.
  const exact = store.findPageByRoute(args.route);
  if (exact) {
    const layouts = exact.layout_chain
      ? `\n  layouts: ${exact.layout_chain}`
      : "";
    return `route: ${exact.route}\n  file:    ${exact.file_path}${layouts}`;
  }

  // Try matching with parameters: turn "/users/123" into "/users/:id" by trying
  // to match against patterns. Simpler: do a LIKE search and pick best.
  const candidates = store.findPagesMatching(stripTrailingSlash(args.route), 20);
  if (candidates.length === 0) {
    return `no page matches route "${args.route}".\nTip: try the dynamic form, e.g. "/profile/:id" or substring like "profile".`;
  }

  const lines = [`no exact match. ${candidates.length} candidate(s):`, ""];
  for (const c of candidates) {
    lines.push(`  ${c.route.padEnd(48)} → ${c.file_path}`);
  }
  return lines.join("\n");
}

export function listApiRoutesTool(store: Store): string {
  const routes = store.allApiRoutes();
  if (routes.length === 0) return "no api routes indexed.";
  const lines = [`api routes: ${routes.length}`, ""];
  for (const r of routes) {
    const m = r.methods ? `  [${r.methods}]` : "";
    lines.push(`  ${r.route.padEnd(40)} → ${r.file_path}${m}`);
  }
  return lines.join("\n");
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") && s.length > 1 ? s.slice(0, -1) : s;
}
