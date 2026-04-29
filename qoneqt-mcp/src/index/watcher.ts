import chokidar from "chokidar";
import { relative } from "node:path";
import type { Store } from "./store.ts";
import { indexAppRouter, indexFile } from "./indexer.ts";
import { runEmbeddingPass } from "./embed-pass.ts";
import type { EmbeddingProvider } from "./embeddings.ts";
import type { ActivityLogger } from "../lib/activity-log.ts";

const DEBOUNCE_MS = 500;
const SOURCE_GLOB = "src/**/*.{js,jsx,ts,tsx}";
const APP_ROUTER_FILES = /\/(page|layout|route)\.(js|jsx|ts|tsx)$/;
const EVENTS_TAIL_INTERVAL_MS = 2000;

export interface WatcherOpts {
  workspace: string;
  store: Store;
  embedder: EmbeddingProvider | null;
  activity: ActivityLogger | null;
  log?: (msg: string) => void;
}

export function startWatcher(opts: WatcherOpts): { stop: () => Promise<void> } {
  const log = opts.log ?? (() => {});
  const watcher = chokidar.watch(SOURCE_GLOB, {
    cwd: opts.workspace,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const dirtyFiles = new Set<string>();
  const removedFiles = new Set<string>();
  let routerDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  }

  async function flush() {
    if (flushing) {
      schedule();
      return;
    }
    flushing = true;
    try {
      const toIndex = [...dirtyFiles];
      const toRemove = [...removedFiles];
      dirtyFiles.clear();
      removedFiles.clear();
      const wasRouterDirty = routerDirty;
      routerDirty = false;

      for (const rel of toRemove) {
        opts.store.removeFile(rel);
        log(`[watcher] removed ${rel}`);
      }
      for (const rel of toIndex) {
        const r = await indexFile(opts.workspace, rel, opts.store, log);
        if (r === "skipped") continue;
        log(`[watcher] reindexed ${rel} (${r.symbols} symbols, ${r.fetches} fetches)`);
      }
      if (wasRouterDirty) {
        await indexAppRouter(opts.workspace, opts.store, log);
      }
      // Pick up any new chunks with embeddings (best-effort; don't error out on API failure).
      if (opts.embedder && toIndex.length > 0) {
        try {
          await runEmbeddingPass(opts.store, log, opts.embedder);
        } catch (err) {
          log(`[watcher] embed-pass error: ${(err as Error).message}`);
        }
      }
    } finally {
      flushing = false;
    }
  }

  watcher.on("add", (rel) => {
    const r = normalize(rel, opts.workspace);
    dirtyFiles.add(r);
    if (APP_ROUTER_FILES.test(r)) routerDirty = true;
    void opts.activity?.recordWatcherEvent(r, "added");
    schedule();
  });
  watcher.on("change", (rel) => {
    const r = normalize(rel, opts.workspace);
    dirtyFiles.add(r);
    if (APP_ROUTER_FILES.test(r)) routerDirty = true;
    void opts.activity?.recordWatcherEvent(r, "modified");
    schedule();
  });
  watcher.on("unlink", (rel) => {
    const r = normalize(rel, opts.workspace);
    removedFiles.add(r);
    if (APP_ROUTER_FILES.test(r)) routerDirty = true;
    void opts.activity?.recordWatcherEvent(r, "deleted");
    schedule();
  });
  watcher.on("error", (err) => {
    log(`[watcher] error: ${(err as Error).message}`);
  });

  // Tail .qoneqt-mcp/git-events.jsonl periodically so git-hook-emitted events
  // (post-commit, post-merge, post-checkout) flow into the activity table.
  const eventsTimer = opts.activity
    ? setInterval(async () => {
        try {
          const n = await opts.activity!.flushPending();
          if (n > 0) {
            log(`[watcher] ingested ${n} git-event(s) from .qoneqt-mcp/git-events.jsonl`);
          }
        } catch (err) {
          log(`[watcher] events-tail error: ${(err as Error).message}`);
        }
      }, EVENTS_TAIL_INTERVAL_MS)
    : null;

  log(`[watcher] watching ${SOURCE_GLOB} under ${opts.workspace}`);

  return {
    stop: async () => {
      if (timer) clearTimeout(timer);
      if (eventsTimer) clearInterval(eventsTimer);
      await watcher.close();
    },
  };
}

function normalize(p: string, workspace: string): string {
  // chokidar may emit absolute or workspace-relative depending on version; normalize.
  if (p.startsWith(workspace)) return relative(workspace, p);
  return p;
}
