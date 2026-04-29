export type SymbolKind =
  | "component"
  | "function"
  | "hook"
  | "context"
  | "class"
  | "variable"
  | "page"
  | "api_route"
  | "layout";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string | null;
  isDefaultExport: boolean;
  isNamedExport: boolean;
  /** Body text used for embedding (component bodies, sliced/truncated). */
  chunkText?: string | null;
}

export interface ExtractedImport {
  source: string;
  importedName: string | null;
  alias: string | null;
  line: number;
}

export type FetchKind = "fetch" | "axios" | "request" | "other";

export interface ExtractedFetch {
  callee: string;
  kind: FetchKind;
  /** Normalised URL template, e.g. "/api/v1/users/:userId/posts" or null if unresolvable. */
  urlTemplate: string | null;
  /** Raw URL source as it appears in code (template literal text, identifier name, etc.). */
  urlRaw: string;
  method: string | null;
  hasAuth: boolean;
  isDynamic: boolean;
  startLine: number;
  endLine: number;
}

export interface ParsedFile {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  fetches: ExtractedFetch[];
  lineCount: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  file_path: string;
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  signature: string | null;
  is_default_export: number;
  is_named_export: number;
}

export interface ImportRow {
  id: number;
  file_id: number;
  file_path: string;
  source: string;
  imported_name: string | null;
  alias: string | null;
  line: number;
}

export interface FetchRow {
  id: number;
  file_id: number;
  file_path: string;
  callee: string;
  kind: FetchKind;
  url_template: string | null;
  url_raw: string;
  method: string | null;
  has_auth: number;
  is_dynamic: number;
  start_line: number;
  end_line: number;
}

export interface PageRow {
  id: number;
  route: string;
  file_path: string;
  layout_chain: string;
  is_dynamic: number;
  is_route_group: number;
}

export interface ApiRouteRow {
  id: number;
  route: string;
  file_path: string;
  methods: string;
}

export interface ChunkRow {
  symbol_id: number;
  file_path: string;
  name: string;
  kind: SymbolKind;
  text: string;
  embedding: Buffer | null;
  start_line: number;
  end_line: number;
}

export type ActivitySource =
  | "watcher"
  | "commit"
  | "merge"
  | "checkout"
  | "rebase"
  | "manual";

export type ActivityAction =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "merged"
  | "checked-out"
  | "rebased"
  | "committed";

export interface ActivityRow {
  id: number;
  ts: number; // unix seconds
  user: string;
  email: string | null;
  source: ActivitySource;
  ref: string | null; // sha / branch
  file_path: string | null;
  action: ActivityAction;
  detail: string | null;
}

export interface ActivityRecord {
  ts: number;
  user: string;
  email?: string | null;
  source: ActivitySource;
  ref?: string | null;
  filePath?: string | null;
  action: ActivityAction;
  detail?: string | null;
}
