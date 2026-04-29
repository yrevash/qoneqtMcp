#!/usr/bin/env bun
import { resolve } from "node:path";
import { Store } from "../index/store.ts";
import { indexWorkspace } from "../index/indexer.ts";
import { runEmbeddingPass } from "../index/embed-pass.ts";
import { getDbPath } from "../lib/paths.ts";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun run src/cli/index-cmd.ts <workspace-path>");
    process.exit(1);
  }
  const workspace = resolve(arg);
  process.env.QONEQT_MCP_WORKSPACE = workspace;

  console.error(`Indexing ${workspace}…`);
  const dbPath = getDbPath(workspace);
  console.error(`DB: ${dbPath}`);

  const store = new Store(dbPath);
  const t0 = Date.now();
  const result = await indexWorkspace(workspace, store, (m) => console.error(m));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const embed = await runEmbeddingPass(store, (m) => console.error(m));

  const stats = store.stats();
  console.error(
    `\nDone in ${elapsed}s + embed ${(embed.durationMs / 1000).toFixed(1)}s. ` +
      `Indexed: ${result.filesIndexed}, skipped: ${result.filesSkipped}.`,
  );
  console.error(
    `Store: ${stats.files} files, ${stats.symbols} symbols, ${stats.imports} imports, ` +
      `${stats.fetches} fetches, ${stats.pages} pages, ${stats.apiRoutes} api routes, ` +
      `${stats.chunks} chunks (${stats.embedded} embedded via ${embed.provider}/${embed.model ?? "n/a"}).`,
  );
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
