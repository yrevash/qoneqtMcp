import type { Store } from "../index/store.ts";
import type { ImportRow, SymbolRow } from "../lib/types.ts";

/**
 * For a Context name (e.g. "AuthContext"), return:
 *   - the definition file (where createContext is called)
 *   - the Provider component (often <Name>Provider in the same file)
 *   - the consumer hook (use<Name>) and where it's called from (via imports)
 *   - direct named-import call sites of the Context itself (rare; usually consumed via the hook)
 */
export function findContextUsageTool(
  store: Store,
  args: { name: string },
): string {
  const name = args.name;
  const matches = store.findSymbolsByName(name);
  const ctx = matches.find((m) => m.kind === "context") ?? matches[0];

  if (!ctx) {
    return `no symbol named "${name}". try find_symbol "${name}" prefix=true to fuzzy-match.`;
  }

  const lines: string[] = [];
  lines.push(`context: ${name}`);
  lines.push(`  defined: ${ctx.file_path}:${ctx.start_line}`);

  // Find the matching Provider component (heuristic: look for a Component named ${name}Provider in the same file)
  const provider = store
    .outlineFile(ctx.file_path)
    .find(
      (s) =>
        (s.name === `${name}Provider` || s.name.endsWith("Provider")) &&
        s.kind === "component",
    );
  if (provider) {
    lines.push(
      `  provider: ${provider.name} (${provider.file_path}:${provider.start_line})`,
    );
  }

  // Find the consumer hook (heuristic: useXxx where Xxx maps to the context)
  const hookCandidates = store
    .outlineFile(ctx.file_path)
    .filter((s) => s.kind === "hook");
  const consumerHook = hookCandidates[0];
  if (consumerHook) {
    lines.push(
      `  consumer hook: ${consumerHook.name} (${consumerHook.file_path}:${consumerHook.start_line})`,
    );
  }

  // Find files that import the context, the provider, or the hook
  const importers = collectImporters(store, [
    name,
    provider?.name ?? null,
    consumerHook?.name ?? null,
  ]);

  // Group importers by what they imported and the file
  const buckets = bucketImports(importers, name, provider?.name, consumerHook?.name);

  lines.push("");
  lines.push(`provider mounting points (${buckets.providers.size}):`);
  for (const [path, lineNos] of buckets.providers) {
    lines.push(`  ${path}  L${[...lineNos].sort((a, b) => a - b).join(",")}`);
  }

  if (consumerHook) {
    lines.push("");
    lines.push(`hook (${consumerHook.name}) consumers (${buckets.hookConsumers.size}):`);
    for (const [path, lineNos] of buckets.hookConsumers) {
      lines.push(`  ${path}  L${[...lineNos].sort((a, b) => a - b).join(",")}`);
    }
  }

  if (buckets.directContextImports.size) {
    lines.push("");
    lines.push(`direct ${name} consumers (${buckets.directContextImports.size}):`);
    for (const [path, lineNos] of buckets.directContextImports) {
      lines.push(`  ${path}  L${[...lineNos].sort((a, b) => a - b).join(",")}`);
    }
  }

  return lines.join("\n");
}

interface UsageBuckets {
  providers: Map<string, Set<number>>;
  hookConsumers: Map<string, Set<number>>;
  directContextImports: Map<string, Set<number>>;
}

function bucketImports(
  rows: ImportRow[],
  contextName: string,
  providerName: string | undefined,
  hookName: string | undefined,
): UsageBuckets {
  const providers = new Map<string, Set<number>>();
  const hookConsumers = new Map<string, Set<number>>();
  const directContextImports = new Map<string, Set<number>>();

  for (const r of rows) {
    if (providerName && r.imported_name === providerName) {
      pushTo(providers, r.file_path, r.line);
    } else if (hookName && r.imported_name === hookName) {
      pushTo(hookConsumers, r.file_path, r.line);
    } else if (r.imported_name === contextName) {
      pushTo(directContextImports, r.file_path, r.line);
    }
  }
  return { providers, hookConsumers, directContextImports };
}

function pushTo(map: Map<string, Set<number>>, key: string, value: number) {
  const set = map.get(key) ?? new Set<number>();
  set.add(value);
  map.set(key, set);
}

function collectImporters(
  store: Store,
  names: (string | null)[],
): ImportRow[] {
  const out: ImportRow[] = [];
  for (const n of names) {
    if (!n) continue;
    out.push(...store.importsBySymbol(n));
  }
  return out;
}

// Re-export to satisfy unused-import warning if SymbolRow needed elsewhere
export type _SymbolRowAlias = SymbolRow;
