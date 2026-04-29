import { resolve, basename } from "node:path";
import { mkdirSync } from "node:fs";

export function getWorkspaceRoot(): string {
  const fromEnv = process.env.QONEQT_MCP_WORKSPACE;
  if (fromEnv) return resolve(fromEnv);
  throw new Error(
    "QONEQT_MCP_WORKSPACE is not set. Pass --workspace or set the env var.",
  );
}

export function getStoreDir(workspace: string): string {
  const slug = basename(workspace).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = resolve(import.meta.dir, "../../.qoneqt-mcp", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbPath(workspace: string): string {
  return resolve(getStoreDir(workspace), "index.sqlite");
}

export function getGrammarPath(): string {
  return resolve(
    import.meta.dir,
    "../../node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  );
}

/**
 * Memory directory lives **inside the user's workspace** (under .qoneqt-mcp/memories/).
 * This puts memories in the user's repo so they can be reviewed in PRs and committed
 * if desired. .qoneqt-mcp/ should be gitignored by default; the user opts in to commit
 * the memories/ subdirectory.
 */
export function getMemoryDir(workspace: string): string {
  const dir = resolve(workspace, ".qoneqt-mcp", "memories");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the workspace's package.json (may not exist). */
export function getWorkspacePackageJson(workspace: string): string {
  return resolve(workspace, "package.json");
}
