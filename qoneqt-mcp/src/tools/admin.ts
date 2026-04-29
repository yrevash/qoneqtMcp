import { Store } from "../index/store.ts";
import { indexWorkspace } from "../index/indexer.ts";
import { getDbPath } from "../lib/paths.ts";

export function statsTool(store: Store): string {
  const s = store.stats();
  const embedder = store.getMeta("embedder") ?? "(none — set EMBEDDING_BASE_URL)";
  const embeddedAt = store.getMeta("embedded_at") ?? "never";
  return [
    "index stats:",
    `  files:       ${s.files}`,
    `  symbols:     ${s.symbols}`,
    `  imports:     ${s.imports}`,
    `  fetches:     ${s.fetches}`,
    `  pages:       ${s.pages}`,
    `  api routes:  ${s.apiRoutes}`,
    `  chunks:      ${s.chunks}  (embedded: ${s.embedded})`,
    `  embedder:    ${embedder}`,
    `  last embed:  ${embeddedAt}`,
  ].join("\n");
}

export async function reindexTool(workspace: string): Promise<string> {
  const dbPath = getDbPath(workspace);
  const store = new Store(dbPath);
  const messages: string[] = [];
  const t0 = Date.now();
  const result = await indexWorkspace(workspace, store, (m) => messages.push(m));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = store.stats();
  store.close();
  return `reindex complete in ${elapsed}s.\nindexed: ${result.filesIndexed}, skipped: ${result.filesSkipped}\nstore now has: ${stats.files} files, ${stats.symbols} symbols, ${stats.imports} imports.`;
}
