import type { MemoryFile, MemoryStore } from "../lib/memory-store.ts";
import { renderFrontmatter } from "../lib/memory-store.ts";

export async function listMemoriesTool(store: MemoryStore): Promise<string> {
  const files = await store.list();
  if (files.length === 0) {
    return `no memories yet at ${store.dir}\n\nrun the \`onboard\` tool to bootstrap the canonical files (architecture, conventions, commands, gotchas, glossary).`;
  }
  const lines = [`memories at ${store.dir}  (${files.length})`, ""];
  for (const f of files) {
    const tags = [
      f.reserved ? "reserved" : "",
      f.frontmatter.status ? f.frontmatter.status : "",
      f.ageDays != null ? `${f.ageDays}d` : "",
    ]
      .filter(Boolean)
      .join(",");
    const tagPart = tags ? `  [${tags}]` : "";
    const title = f.frontmatter.title ?? f.name;
    lines.push(`  ${f.name.padEnd(20)} ${title}${tagPart}`);
    if (f.frontmatter.scope) lines.push(`    scope: ${f.frontmatter.scope}`);
  }
  lines.push("");
  lines.push("call read_memory <name> to view a memory.");
  return lines.join("\n");
}

export async function readMemoryTool(
  store: MemoryStore,
  args: { name: string },
): Promise<string> {
  const m = await store.read(args.name);
  if (!m) return `no memory named "${args.name}". call list_memories to see what's available.`;
  return formatMemory(m);
}

export async function writeMemoryTool(
  store: MemoryStore,
  args: {
    name: string;
    body: string;
    title?: string;
    scope?: string;
    status?: "stable" | "drifting" | "deprecated";
    related?: string[];
    overwrite?: boolean;
  },
): Promise<string> {
  if (!args.overwrite && (await store.exists(args.name))) {
    return `memory "${args.name}" already exists. pass overwrite=true to replace it, or pick a different name.`;
  }
  const m = await store.write(args.name, args.body, {
    title: args.title,
    scope: args.scope,
    status: args.status,
    related: args.related,
  });
  return `wrote memory "${m.name}"  (${m.bytes} bytes)\npath: ${m.path}\nlast_verified: ${m.frontmatter.last_verified}`;
}

export async function deleteMemoryTool(
  store: MemoryStore,
  args: { name: string },
): Promise<string> {
  const ok = await store.delete(args.name);
  return ok ? `deleted memory "${args.name}".` : `no memory named "${args.name}" to delete.`;
}

function formatMemory(m: MemoryFile): string {
  const fmText = renderFrontmatter(m.frontmatter);
  const ageNote =
    m.ageDays != null && m.ageDays > 30
      ? `\n[note: last_verified ${m.ageDays} days ago — confirm against current code before relying on this]`
      : "";
  return `memory: ${m.name}  (${m.path})${ageNote}\n\n${fmText}\n\n${m.body}`;
}
