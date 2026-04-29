import { readFile } from "node:fs/promises";
import { Glob } from "bun";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { parseSource } from "./parser.ts";
import { extractFromTree } from "./extract.ts";
import { walkAppRouter } from "./router.ts";
import type { Store } from "./store.ts";

const SOURCE_GLOB = "src/**/*.{js,jsx,ts,tsx}";
const SKIP_LARGER_THAN = 4000;

export async function indexWorkspace(
  workspace: string,
  store: Store,
  log: (msg: string) => void = () => {},
): Promise<{ filesIndexed: number; filesSkipped: number; symbols: number }> {
  const glob = new Glob(SOURCE_GLOB);
  let filesIndexed = 0;
  let filesSkipped = 0;
  let symbolCount = 0;

  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    const result = await indexFile(workspace, rel, store, log);
    if (result === "skipped") {
      filesSkipped++;
    } else {
      filesIndexed++;
      symbolCount += result.symbols;
    }
    if (filesIndexed % 100 === 0 && filesIndexed > 0) {
      log(`indexed ${filesIndexed} files, ${symbolCount} symbols so far…`);
    }
  }

  // Index App Router pages and api routes
  await indexAppRouter(workspace, store, log);

  return { filesIndexed, filesSkipped, symbols: symbolCount };
}

export async function indexFile(
  workspace: string,
  relPath: string,
  store: Store,
  log: (msg: string) => void = () => {},
): Promise<"skipped" | { symbols: number; fetches: number }> {
  const abs = `${workspace}/${relPath}`;
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch (err) {
    log(`SKIP read-error ${relPath}: ${(err as Error).message}`);
    return "skipped";
  }

  const lineCount = source.split("\n").length;
  const hash = sha1(source);

  if (lineCount > SKIP_LARGER_THAN) {
    log(`SKIP huge ${relPath} (${lineCount} lines)`);
    store.upsertFile(relPath, hash, lineCount);
    return "skipped";
  }

  let parsed;
  try {
    const tree = await parseSource(source, relPath);
    parsed = extractFromTree(tree, source);
  } catch (err) {
    log(`SKIP parse-error ${relPath}: ${(err as Error).message}`);
    return "skipped";
  }

  const fileId = store.upsertFile(relPath, hash, parsed.lineCount);
  for (const sym of parsed.symbols) store.insertSymbol(fileId, sym);
  for (const imp of parsed.imports) store.insertImport(fileId, imp);
  for (const f of parsed.fetches) store.insertFetch(fileId, f);

  return { symbols: parsed.symbols.length, fetches: parsed.fetches.length };
}

export async function indexAppRouter(
  workspace: string,
  store: Store,
  log: (msg: string) => void = () => {},
) {
  const t0 = Date.now();
  const { pages, apiRoutes } = await walkAppRouter(workspace);
  store.clearPages();
  for (const p of pages) {
    store.upsertPage({
      route: p.route,
      filePath: p.filePath,
      layoutChain: p.layoutChain,
      isDynamic: p.isDynamic,
      isRouteGroup: p.isRouteGroup,
    });
  }
  for (const a of apiRoutes) {
    store.upsertApiRoute(a.route, a.filePath, a.methods);
  }
  log(
    `app-router: ${pages.length} pages, ${apiRoutes.length} api routes (${Date.now() - t0}ms)`,
  );
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function relPath(workspace: string, abs: string): string {
  return relative(workspace, abs);
}
