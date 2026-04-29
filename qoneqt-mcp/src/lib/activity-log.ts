/**
 * Activity log: who-changed-what attribution.
 *
 * Sources:
 *   - watcher: chokidar fired for a file save (current user from git config)
 *   - commit / merge / checkout / rebase: emitted by git hooks via JSONL events file
 *
 * Storage: activity table in the same SQLite index. Queryable via tools.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "../index/store.ts";
import type {
  ActivityAction,
  ActivityRecord,
  ActivitySource,
} from "./types.ts";
import { readGitConfigUser } from "./git.ts";

export interface ActivityLogger {
  recordWatcherEvent(filePath: string, action: ActivityAction): Promise<void>;
  recordExternal(rec: Omit<ActivityRecord, "ts"> & { ts?: number }): void;
  flushPending(): Promise<number>; // ingest events file; returns count appended
}

const EVENTS_FILE_NAME = "git-events.jsonl";

export function createActivityLogger(opts: {
  workspace: string;
  store: Store;
  log?: (msg: string) => void;
}): ActivityLogger {
  const log = opts.log ?? (() => {});
  let cachedUser: { name: string; email: string | null } | null = null;
  let cachedAt = 0;

  // Where the git hooks drop events (workspace-local; gitignored).
  const eventsDir = resolve(opts.workspace, ".qoneqt-mcp");
  const eventsPath = resolve(eventsDir, EVENTS_FILE_NAME);
  let lastFileSize = 0;

  // Track the last reported file path per user to avoid logging on every keystroke
  // (the watcher fires once per file save, but rapid edits to the same file in <2s
  // are deduped here so we don't bloat the table).
  const recentSeen = new Map<string, number>(); // key = `${user}|${file}|${action}` → unix ts

  async function getUser() {
    const now = Date.now();
    if (cachedUser && now - cachedAt < 60_000) return cachedUser;
    cachedUser = await readGitConfigUser(opts.workspace);
    cachedAt = now;
    return cachedUser;
  }

  return {
    async recordWatcherEvent(filePath: string, action: ActivityAction): Promise<void> {
      const u = await getUser();
      const ts = Math.floor(Date.now() / 1000);
      const key = `${u.name}|${filePath}|${action}`;
      const last = recentSeen.get(key) ?? 0;
      if (ts - last < 2) return; // dedupe rapid bursts
      recentSeen.set(key, ts);
      opts.store.insertActivity({
        ts,
        user: u.name,
        email: u.email,
        source: "watcher",
        filePath,
        action,
      });
    },

    recordExternal(rec) {
      const ts = rec.ts ?? Math.floor(Date.now() / 1000);
      opts.store.insertActivity({ ...rec, ts });
    },

    async flushPending(): Promise<number> {
      if (!existsSync(eventsPath)) {
        if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
        writeFileSync(eventsPath, "");
        return 0;
      }
      const file = Bun.file(eventsPath);
      const size = file.size;
      if (size <= lastFileSize) {
        // file may have been truncated externally — reset
        if (size < lastFileSize) lastFileSize = 0;
        if (size === 0) return 0;
      }
      const slice = file.slice(lastFileSize);
      const text = await slice.text();
      lastFileSize = size;

      let appended = 0;
      for (const line of text.split("\n")) {
        const trim = line.trim();
        if (!trim) continue;
        try {
          const evt = JSON.parse(trim) as {
            ts?: number;
            user: string;
            email?: string | null;
            source: ActivitySource;
            ref?: string | null;
            file_path?: string | null;
            action: ActivityAction;
            detail?: string | null;
          };
          opts.store.insertActivity({
            ts: evt.ts ?? Math.floor(Date.now() / 1000),
            user: evt.user,
            email: evt.email ?? null,
            source: evt.source,
            ref: evt.ref ?? null,
            filePath: evt.file_path ?? null,
            action: evt.action,
            detail: evt.detail ?? null,
          });
          appended++;
        } catch (err) {
          log(`[activity] bad JSONL line skipped: ${(err as Error).message}`);
        }
      }
      return appended;
    },
  };
}

export function eventsFilePath(workspace: string): string {
  return resolve(workspace, ".qoneqt-mcp", EVENTS_FILE_NAME);
}
