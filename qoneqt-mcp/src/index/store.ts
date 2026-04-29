import { Database } from "bun:sqlite";
import type {
  ActivityRecord,
  ActivityRow,
  ApiRouteRow,
  ChunkRow,
  ExtractedFetch,
  ExtractedImport,
  ExtractedSymbol,
  FetchRow,
  ImportRow,
  PageRow,
  SymbolRow,
} from "../lib/types.ts";

/**
 * Schema version. Bump whenever the schema changes. On Store init we compare against
 * meta.schema_version; if different (or unset on a populated DB), the tables are dropped
 * and recreated. Callers should reindex after a migration.
 */
export const SCHEMA_VERSION = 2;

export class Store {
  private db: Database;
  private upsertFileStmt!: ReturnType<Database["prepare"]>;
  private deleteFileStmt!: ReturnType<Database["prepare"]>;
  private insertSymbolStmt!: ReturnType<Database["prepare"]>;
  private insertImportStmt!: ReturnType<Database["prepare"]>;
  private insertFetchStmt!: ReturnType<Database["prepare"]>;
  private insertChunkStmt!: ReturnType<Database["prepare"]>;
  private updateChunkEmbeddingStmt!: ReturnType<Database["prepare"]>;
  private upsertPageStmt!: ReturnType<Database["prepare"]>;
  private upsertApiRouteStmt!: ReturnType<Database["prepare"]>;

  /** Set during construction if the schema was reset for a version mismatch. */
  readonly schemaMigrated: boolean;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.schemaMigrated = this.maybeMigrate();
    this.applySchema();
    this.prepareStatements();
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  /**
   * If the existing schema_version doesn't match SCHEMA_VERSION, drop everything and
   * start fresh. Returns true if a migration occurred.
   */
  private maybeMigrate(): boolean {
    // Check if any tables exist at all (fresh DB → no migration)
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    if (tables.length === 0) return false;

    // Read existing schema version (best-effort; meta table might not exist on very old DBs)
    let existing: string | null = null;
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | null;
      existing = row?.value ?? null;
    } catch {
      existing = null;
    }
    if (existing === String(SCHEMA_VERSION)) return false;

    // Drop all known tables (and their FTS shadow tables). Order matters because of FKs.
    for (const t of tables) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${t.name}`);
      } catch {
        // FTS5 shadow tables may complain; ignore.
      }
    }
    return true;
  }

  private applySchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT UNIQUE NOT NULL,
        hash        TEXT NOT NULL,
        line_count  INTEGER NOT NULL,
        indexed_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id            INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        kind               TEXT NOT NULL,
        start_line         INTEGER NOT NULL,
        end_line           INTEGER NOT NULL,
        signature          TEXT,
        is_default_export  INTEGER NOT NULL DEFAULT 0,
        is_named_export    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind      ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_id   ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);

      CREATE TABLE IF NOT EXISTS imports (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source         TEXT NOT NULL,
        imported_name  TEXT,
        alias          TEXT,
        line           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imports_source       ON imports(source);
      CREATE INDEX IF NOT EXISTS idx_imports_file_id      ON imports(file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_imported     ON imports(imported_name);

      CREATE TABLE IF NOT EXISTS fetches (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        callee         TEXT NOT NULL,
        kind           TEXT NOT NULL,
        url_template   TEXT,
        url_raw        TEXT NOT NULL,
        method         TEXT,
        has_auth       INTEGER NOT NULL DEFAULT 0,
        is_dynamic     INTEGER NOT NULL DEFAULT 0,
        start_line     INTEGER NOT NULL,
        end_line       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fetches_file_id  ON fetches(file_id);
      CREATE INDEX IF NOT EXISTS idx_fetches_template ON fetches(url_template);
      CREATE INDEX IF NOT EXISTS idx_fetches_method   ON fetches(method);

      CREATE TABLE IF NOT EXISTS pages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        route          TEXT UNIQUE NOT NULL,
        file_path      TEXT UNIQUE NOT NULL,
        layout_chain   TEXT NOT NULL DEFAULT '',
        is_dynamic     INTEGER NOT NULL DEFAULT 0,
        is_route_group INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pages_route ON pages(route);

      CREATE TABLE IF NOT EXISTS api_routes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        route       TEXT UNIQUE NOT NULL,
        file_path   TEXT UNIQUE NOT NULL,
        methods     TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_api_routes_route ON api_routes(route);

      CREATE TABLE IF NOT EXISTS chunks (
        symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        embedding   BLOB
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='',
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS activity (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        user       TEXT NOT NULL,
        email      TEXT,
        source     TEXT NOT NULL,
        ref        TEXT,
        file_path  TEXT,
        action     TEXT NOT NULL,
        detail     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ts        ON activity(ts);
      CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity(user);
      CREATE INDEX IF NOT EXISTS idx_activity_file_path ON activity(file_path);
      CREATE INDEX IF NOT EXISTS idx_activity_source    ON activity(source);
    `);
  }

  private prepareStatements() {
    this.upsertFileStmt = this.db.prepare(
      `INSERT INTO files (path, hash, line_count, indexed_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         hash = excluded.hash,
         line_count = excluded.line_count,
         indexed_at = excluded.indexed_at
       RETURNING id`,
    );
    this.deleteFileStmt = this.db.prepare("DELETE FROM files WHERE path = ?");
    this.insertSymbolStmt = this.db.prepare(
      `INSERT INTO symbols
        (file_id, name, kind, start_line, end_line, signature, is_default_export, is_named_export)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`,
    );
    this.insertImportStmt = this.db.prepare(
      `INSERT INTO imports (file_id, source, imported_name, alias, line)
        VALUES (?, ?, ?, ?, ?)`,
    );
    this.insertFetchStmt = this.db.prepare(
      `INSERT INTO fetches
        (file_id, callee, kind, url_template, url_raw, method, has_auth, is_dynamic, start_line, end_line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertChunkStmt = this.db.prepare(
      `INSERT OR REPLACE INTO chunks (symbol_id, text, embedding) VALUES (?, ?, ?)`,
    );
    this.updateChunkEmbeddingStmt = this.db.prepare(
      `UPDATE chunks SET embedding = ? WHERE symbol_id = ?`,
    );
    this.upsertPageStmt = this.db.prepare(
      `INSERT INTO pages (route, file_path, layout_chain, is_dynamic, is_route_group)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(route) DO UPDATE SET
         file_path = excluded.file_path,
         layout_chain = excluded.layout_chain,
         is_dynamic = excluded.is_dynamic,
         is_route_group = excluded.is_route_group`,
    );
    this.upsertApiRouteStmt = this.db.prepare(
      `INSERT INTO api_routes (route, file_path, methods)
       VALUES (?, ?, ?)
       ON CONFLICT(route) DO UPDATE SET
         file_path = excluded.file_path,
         methods = excluded.methods`,
    );
  }

  upsertFile(path: string, hash: string, lineCount: number): number {
    const row = this.upsertFileStmt.get(path, hash, lineCount) as { id: number };
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(row.id);
    this.db.prepare("DELETE FROM imports WHERE file_id = ?").run(row.id);
    this.db.prepare("DELETE FROM fetches WHERE file_id = ?").run(row.id);
    return row.id;
  }

  insertSymbol(fileId: number, sym: ExtractedSymbol): number {
    const row = this.insertSymbolStmt.get(
      fileId,
      sym.name,
      sym.kind,
      sym.startLine,
      sym.endLine,
      sym.signature,
      sym.isDefaultExport ? 1 : 0,
      sym.isNamedExport ? 1 : 0,
    ) as { id: number };
    if (sym.chunkText) {
      this.insertChunk(row.id, sym.chunkText);
    }
    return row.id;
  }

  insertImport(fileId: number, imp: ExtractedImport) {
    this.insertImportStmt.run(fileId, imp.source, imp.importedName, imp.alias, imp.line);
  }

  insertFetch(fileId: number, f: ExtractedFetch) {
    this.insertFetchStmt.run(
      fileId,
      f.callee,
      f.kind,
      f.urlTemplate,
      f.urlRaw,
      f.method,
      f.hasAuth ? 1 : 0,
      f.isDynamic ? 1 : 0,
      f.startLine,
      f.endLine,
    );
  }

  insertChunk(symbolId: number, text: string) {
    this.insertChunkStmt.run(symbolId, text, null);
    this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(symbolId);
    this.db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)").run(symbolId, text);
  }

  updateChunkEmbedding(symbolId: number, embedding: Buffer) {
    this.updateChunkEmbeddingStmt.run(embedding, symbolId);
  }

  upsertPage(p: {
    route: string;
    filePath: string;
    layoutChain: string[];
    isDynamic: boolean;
    isRouteGroup: boolean;
  }) {
    this.upsertPageStmt.run(
      p.route,
      p.filePath,
      p.layoutChain.join(" > "),
      p.isDynamic ? 1 : 0,
      p.isRouteGroup ? 1 : 0,
    );
  }

  upsertApiRoute(route: string, filePath: string, methods: string[]) {
    this.upsertApiRouteStmt.run(route, filePath, methods.sort().join(","));
  }

  removeFile(path: string) {
    this.deleteFileStmt.run(path);
  }

  clearPages() {
    this.db.exec("DELETE FROM pages");
    this.db.exec("DELETE FROM api_routes");
  }

  invalidateAllEmbeddings() {
    this.db.exec("UPDATE chunks SET embedding = NULL");
  }

  // ---------- activity ----------
  insertActivity(rec: ActivityRecord) {
    this.db
      .prepare(
        `INSERT INTO activity (ts, user, email, source, ref, file_path, action, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.ts,
        rec.user,
        rec.email ?? null,
        rec.source,
        rec.ref ?? null,
        rec.filePath ?? null,
        rec.action,
        rec.detail ?? null,
      );
  }

  recentActivity(opts: {
    user?: string;
    file?: string;
    source?: string;
    since?: number;
    limit?: number;
  } = {}): ActivityRow[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.user) {
      clauses.push("user = ?");
      params.push(opts.user);
    }
    if (opts.file) {
      clauses.push("file_path LIKE ?");
      params.push(`%${opts.file}%`);
    }
    if (opts.source) {
      clauses.push("source = ?");
      params.push(opts.source);
    }
    if (opts.since != null) {
      clauses.push("ts >= ?");
      params.push(opts.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM activity ${where} ORDER BY ts DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit) as ActivityRow[];
  }

  fileTouchersSince(filePath: string, since: number, limit = 20): {
    user: string;
    email: string | null;
    actions: number;
    last_ts: number;
  }[] {
    return this.db
      .prepare(
        `SELECT user, email, COUNT(*) as actions, MAX(ts) as last_ts
         FROM activity WHERE file_path = ? AND ts >= ?
         GROUP BY user, email ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(filePath, since, limit) as {
      user: string;
      email: string | null;
      actions: number;
      last_ts: number;
    }[];
  }

  userFilesTouched(user: string, since: number, limit = 50): {
    file_path: string;
    actions: number;
    last_ts: number;
  }[] {
    return this.db
      .prepare(
        `SELECT file_path, COUNT(*) as actions, MAX(ts) as last_ts
         FROM activity WHERE user = ? AND ts >= ? AND file_path IS NOT NULL
         GROUP BY file_path ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(user, since, limit) as {
      file_path: string;
      actions: number;
      last_ts: number;
    }[];
  }

  pruneActivityOlderThan(ts: number): number {
    const r = this.db.prepare("DELETE FROM activity WHERE ts < ?").run(ts);
    return Number(r.changes ?? 0);
  }

  findSymbolsByName(name: string, kind?: string): SymbolRow[] {
    const sql = kind
      ? `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name = ? AND s.kind = ?
         ORDER BY s.is_default_export DESC, s.is_named_export DESC, f.path ASC`
      : `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name = ?
         ORDER BY s.is_default_export DESC, s.is_named_export DESC, f.path ASC`;
    return (
      kind ? this.db.prepare(sql).all(name, kind) : this.db.prepare(sql).all(name)
    ) as SymbolRow[];
  }

  findSymbolsByPrefix(prefix: string, kind?: string, limit = 50): SymbolRow[] {
    const sql = kind
      ? `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? AND s.kind = ?
         ORDER BY length(s.name) ASC, f.path ASC LIMIT ?`
      : `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ?
         ORDER BY length(s.name) ASC, f.path ASC LIMIT ?`;
    const args = kind ? [`${prefix}%`, kind, limit] : [`${prefix}%`, limit];
    return this.db.prepare(sql).all(...args) as SymbolRow[];
  }

  outlineFile(filePath: string): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path = ?
         ORDER BY s.start_line ASC`,
      )
      .all(filePath) as SymbolRow[];
  }

  // ---------- fetches ----------
  fetchesInFile(filePath: string): FetchRow[] {
    return this.db
      .prepare(
        `SELECT fc.*, f.path as file_path FROM fetches fc
         JOIN files f ON f.id = fc.file_id
         WHERE f.path = ?
         ORDER BY fc.start_line ASC`,
      )
      .all(filePath) as FetchRow[];
  }

  fetchesByGlob(globPrefix: string): FetchRow[] {
    return this.db
      .prepare(
        `SELECT fc.*, f.path as file_path FROM fetches fc
         JOIN files f ON f.id = fc.file_id
         WHERE f.path LIKE ?
         ORDER BY f.path, fc.start_line`,
      )
      .all(globPrefix) as FetchRow[];
  }

  fetchesByEndpoint(pattern: string, limit = 200): FetchRow[] {
    return this.db
      .prepare(
        `SELECT fc.*, f.path as file_path FROM fetches fc
         JOIN files f ON f.id = fc.file_id
         WHERE fc.url_template LIKE ? OR fc.url_raw LIKE ?
         ORDER BY f.path, fc.start_line LIMIT ?`,
      )
      .all(`%${pattern}%`, `%${pattern}%`, limit) as FetchRow[];
  }

  // ---------- pages ----------
  allPages(): PageRow[] {
    return this.db.prepare(`SELECT * FROM pages ORDER BY route ASC`).all() as PageRow[];
  }

  findPageByRoute(route: string): PageRow | null {
    return this.db.prepare(`SELECT * FROM pages WHERE route = ?`).get(route) as PageRow | null;
  }

  findPagesMatching(prefix: string, limit = 50): PageRow[] {
    return this.db
      .prepare(`SELECT * FROM pages WHERE route LIKE ? ORDER BY route ASC LIMIT ?`)
      .all(`%${prefix}%`, limit) as PageRow[];
  }

  allApiRoutes(): ApiRouteRow[] {
    return this.db
      .prepare(`SELECT * FROM api_routes ORDER BY route ASC`)
      .all() as ApiRouteRow[];
  }

  // ---------- imports / context usage ----------
  importsOf(source: string): ImportRow[] {
    return this.db
      .prepare(
        `SELECT i.*, f.path as file_path FROM imports i
         JOIN files f ON f.id = i.file_id
         WHERE i.source = ?
         ORDER BY f.path ASC`,
      )
      .all(source) as ImportRow[];
  }

  importsBySymbol(name: string, sourceLike?: string): ImportRow[] {
    const sql = sourceLike
      ? `SELECT i.*, f.path as file_path FROM imports i
         JOIN files f ON f.id = i.file_id
         WHERE i.imported_name = ? AND i.source LIKE ?
         ORDER BY f.path ASC`
      : `SELECT i.*, f.path as file_path FROM imports i
         JOIN files f ON f.id = i.file_id
         WHERE i.imported_name = ?
         ORDER BY f.path ASC`;
    return (
      sourceLike
        ? this.db.prepare(sql).all(name, sourceLike)
        : this.db.prepare(sql).all(name)
    ) as ImportRow[];
  }

  // ---------- chunks (for embeddings + FTS) ----------
  allComponentChunks(): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.symbol_id, c.text, c.embedding,
                s.name, s.kind, s.start_line, s.end_line,
                f.path as file_path
         FROM chunks c
         JOIN symbols s ON s.id = c.symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE s.kind IN ('component', 'hook')`,
      )
      .all() as ChunkRow[];
  }

  ftsSearchChunks(query: string, limit = 30): { symbol_id: number; rank: number }[] {
    // FTS5 with bm25() — lower rank = better. Negate for ordering convenience.
    return this.db
      .prepare(
        `SELECT rowid as symbol_id, rank
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as { symbol_id: number; rank: number }[];
  }

  chunksMissingEmbedding(): { symbol_id: number; text: string }[] {
    return this.db
      .prepare(`SELECT symbol_id, text FROM chunks WHERE embedding IS NULL`)
      .all() as { symbol_id: number; text: string }[];
  }

  symbolById(id: number): SymbolRow | null {
    return this.db
      .prepare(
        `SELECT s.*, f.path as file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.id = ?`,
      )
      .get(id) as SymbolRow | null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | null;
    return r?.value ?? null;
  }

  stats() {
    const f = this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    const s = this.db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number };
    const i = this.db.prepare("SELECT COUNT(*) as c FROM imports").get() as { c: number };
    const fc = this.db.prepare("SELECT COUNT(*) as c FROM fetches").get() as { c: number };
    const p = this.db.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    const ar = this.db.prepare("SELECT COUNT(*) as c FROM api_routes").get() as { c: number };
    const ch = this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number };
    const eb = this.db
      .prepare("SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL")
      .get() as { c: number };
    return {
      files: f.c,
      symbols: s.c,
      imports: i.c,
      fetches: fc.c,
      pages: p.c,
      apiRoutes: ar.c,
      chunks: ch.c,
      embedded: eb.c,
    };
  }

  close() {
    this.db.close();
  }
}
