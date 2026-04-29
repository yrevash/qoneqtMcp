import { Glob } from "bun";
import { readFile } from "node:fs/promises";

const APP_DIR = "src/app";
const PAGE_GLOB = `${APP_DIR}/**/page.{js,jsx}`;
const LAYOUT_GLOB = `${APP_DIR}/**/layout.{js,jsx}`;
const API_GLOB = `${APP_DIR}/api/**/route.{js,jsx}`;

export interface DiscoveredPage {
  filePath: string;
  route: string;
  layoutChain: string[];
  isDynamic: boolean;
  isRouteGroup: boolean;
}

export interface DiscoveredApiRoute {
  filePath: string;
  route: string;
  methods: string[];
}

export async function walkAppRouter(workspace: string): Promise<{
  pages: DiscoveredPage[];
  apiRoutes: DiscoveredApiRoute[];
}> {
  const layouts = await collectLayouts(workspace);
  const pages = await collectPages(workspace, layouts);
  const apiRoutes = await collectApiRoutes(workspace);
  return { pages, apiRoutes };
}

async function collectLayouts(workspace: string): Promise<Map<string, string>> {
  // Maps directory (relative to APP_DIR) → file path
  const map = new Map<string, string>();
  const glob = new Glob(LAYOUT_GLOB);
  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    map.set(dir, rel);
  }
  return map;
}

async function collectPages(
  workspace: string,
  layouts: Map<string, string>,
): Promise<DiscoveredPage[]> {
  const out: DiscoveredPage[] = [];
  const glob = new Glob(PAGE_GLOB);
  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    const route = pathToRoute(dir);
    const isDynamic = /\[/.test(route) || /\:/.test(route);
    const isRouteGroup = /\(.*?\)/.test(rel);
    const chain = layoutChainFor(dir, layouts);
    out.push({
      filePath: rel,
      route,
      layoutChain: chain,
      isDynamic,
      isRouteGroup,
    });
  }
  out.sort((a, b) => a.route.localeCompare(b.route));
  return out;
}

async function collectApiRoutes(workspace: string): Promise<DiscoveredApiRoute[]> {
  const out: DiscoveredApiRoute[] = [];
  const glob = new Glob(API_GLOB);
  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    const route = pathToRoute(dir);
    const methods = await detectExportedMethods(`${workspace}/${rel}`);
    out.push({ filePath: rel, route, methods });
  }
  out.sort((a, b) => a.route.localeCompare(b.route));
  return out;
}

function layoutChainFor(dir: string, layouts: Map<string, string>): string[] {
  // Walk from APP_DIR down to `dir`, picking up any layouts on the way.
  const chain: string[] = [];
  const segs = dir.split("/").filter(Boolean);
  // Assume segs starts with src,app
  let acc = "";
  for (let i = 0; i < segs.length; i++) {
    acc = i === 0 ? segs[0]! : `${acc}/${segs[i]}`;
    const found = layouts.get(acc);
    if (found) chain.push(found);
  }
  return chain;
}

/**
 * Convert an App Router directory path (relative to workspace, e.g. "src/app/profile/[id]/edit")
 * into a Next.js route ("/profile/:id/edit"), respecting Next.js conventions:
 *  - strip "src/app" prefix
 *  - drop "(group)" segments (route groups don't appear in the URL)
 *  - "[name]" → ":name"
 *  - "[...slug]" → "*slug" (catch-all)
 *  - "[[...slug]]" → "*slug?" (optional catch-all)
 *  - "@slot" stays as a slot indicator (rare; we mark with @)
 *  - "(.)bar" / "(..)bar" / "(...)bar" → intercepting; we keep ":intercept:bar"
 */
export function pathToRoute(relDir: string): string {
  // Drop "src/app"
  let p = relDir;
  if (p.startsWith(`${APP_DIR}/`)) p = p.slice(APP_DIR.length + 1);
  else if (p === APP_DIR) p = "";

  if (!p) return "/";

  const segs = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const seg of segs) {
    if (/^\(.*\)$/.test(seg)) {
      // Route group like (auth) — invisible in URL
      continue;
    }
    if (seg.startsWith("@")) {
      // Parallel route slot — represent as "@slot"
      out.push(seg);
      continue;
    }
    if (seg.startsWith("(.)") || seg.startsWith("(..)") || seg.startsWith("(...)")) {
      // Intercepted route — keep marker for visibility
      out.push(`:intercept:${seg.replace(/^\((\.+)\)/, "")}`);
      continue;
    }
    const optionalCatchAll = seg.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAll) {
      out.push(`*${optionalCatchAll[1]}?`);
      continue;
    }
    const catchAll = seg.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      out.push(`*${catchAll[1]}`);
      continue;
    }
    const dyn = seg.match(/^\[([^\]]+)\]$/);
    if (dyn) {
      out.push(`:${dyn[1]}`);
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

async function detectExportedMethods(absPath: string): Promise<string[]> {
  try {
    const text = await readFile(absPath, "utf8");
    const methods: string[] = [];
    for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      // Match: export async function VERB(...), export function VERB(...), export const VERB =
      const re = new RegExp(
        `export\\s+(async\\s+)?(function\\s+${verb}\\s*\\(|const\\s+${verb}\\s*=)`,
      );
      if (re.test(text)) methods.push(verb);
    }
    return methods;
  } catch {
    return [];
  }
}
