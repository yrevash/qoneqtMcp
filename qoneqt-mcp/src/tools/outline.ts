import type { Store } from "../index/store.ts";
import type { SymbolRow } from "../lib/types.ts";

export function outlineFileTool(
  store: Store,
  args: { path: string },
): string {
  const rows = store.outlineFile(args.path);
  if (rows.length === 0) {
    return `no symbols indexed for ${args.path}\n(file may not exist, may not be JS/JSX, or may be too large to index — try read_file)`;
  }

  const lines = [`outline: ${args.path}  (${rows.length} symbols)`];
  for (const r of rows) {
    lines.push(formatSymbolRow(r));
  }
  return lines.join("\n");
}

export function formatSymbolRow(r: SymbolRow): string {
  const tag = exportTag(r);
  const sig = r.signature ? `  ${r.signature}` : "";
  return `  L${r.start_line.toString().padStart(4, " ")}-${r.end_line.toString().padEnd(4, " ")} [${r.kind}]${tag} ${r.name}${sig}`;
}

function exportTag(r: SymbolRow): string {
  if (r.is_default_export) return " (default-export)";
  if (r.is_named_export) return " (export)";
  return "";
}
