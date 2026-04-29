import { resolve } from "node:path";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { getMemoryDir } from "./paths.ts";

const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RESERVED_NAMES = new Set([
  "_index",
  "architecture",
  "conventions",
  "commands",
  "gotchas",
  "glossary",
]);

export interface MemoryFrontmatter {
  title?: string;
  scope?: string;
  status?: "stable" | "drifting" | "deprecated";
  last_verified?: string; // ISO date
  related?: string[];
  [k: string]: unknown;
}

export interface MemoryFile {
  name: string;
  path: string;
  frontmatter: MemoryFrontmatter;
  body: string;
  /** True if this is one of the reserved/canonical files. */
  reserved: boolean;
  /** Days since last_verified (or since file mtime if no frontmatter). */
  ageDays: number | null;
  bytes: number;
}

export interface MemoryStore {
  workspace: string;
  dir: string;
  list(): Promise<MemoryFile[]>;
  read(name: string): Promise<MemoryFile | null>;
  write(name: string, body: string, frontmatter?: MemoryFrontmatter): Promise<MemoryFile>;
  delete(name: string): Promise<boolean>;
  exists(name: string): Promise<boolean>;
}

export function createMemoryStore(workspace: string): MemoryStore {
  const dir = getMemoryDir(workspace);

  return {
    workspace,
    dir,

    async list(): Promise<MemoryFile[]> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const out: MemoryFile[] = [];
      for (const f of entries) {
        if (!f.endsWith(".md")) continue;
        const name = f.slice(0, -3);
        const m = await this.read(name);
        if (m) out.push(m);
      }
      out.sort((a, b) => {
        // Reserved files first (in conventional order), then alphabetic
        const ai = reservedOrder(a.name);
        const bi = reservedOrder(b.name);
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
      return out;
    },

    async read(name: string): Promise<MemoryFile | null> {
      const p = pathFor(dir, name);
      let raw: string;
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        [raw, stats] = await Promise.all([readFile(p, "utf8"), stat(p)]);
      } catch {
        return null;
      }
      const { frontmatter, body } = parseFrontmatter(raw);
      const ageDays = computeAgeDays(frontmatter, stats.mtime);
      return {
        name,
        path: p,
        frontmatter,
        body,
        reserved: RESERVED_NAMES.has(name),
        ageDays,
        bytes: stats.size,
      };
    },

    async write(
      name: string,
      body: string,
      frontmatter: MemoryFrontmatter = {},
    ): Promise<MemoryFile> {
      validateName(name);
      const today = new Date().toISOString().slice(0, 10);
      const merged: MemoryFrontmatter = {
        title: frontmatter.title ?? humanize(name),
        ...frontmatter,
        last_verified: today,
      };
      const text = renderFrontmatter(merged) + "\n" + body.trimEnd() + "\n";
      const p = pathFor(dir, name);
      await writeFile(p, text, "utf8");
      const m = await this.read(name);
      if (!m) throw new Error("write: read-back failed");
      return m;
    },

    async delete(name: string): Promise<boolean> {
      validateName(name);
      const p = pathFor(dir, name);
      try {
        await unlink(p);
        return true;
      } catch {
        return false;
      }
    },

    async exists(name: string): Promise<boolean> {
      try {
        await stat(pathFor(dir, name));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function pathFor(dir: string, name: string): string {
  return resolve(dir, `${name}.md`);
}

function validateName(name: string) {
  if (!MEMORY_NAME_RE.test(name) && name !== "_index") {
    throw new Error(
      `invalid memory name "${name}". Use kebab-case alphanum (a–z, 0–9, '-', '_'); reserved: _index.`,
    );
  }
}

function reservedOrder(name: string): number {
  const order = ["_index", "architecture", "conventions", "commands", "gotchas", "glossary"];
  const i = order.indexOf(name);
  return i === -1 ? 999 : i;
}

function humanize(name: string): string {
  return name
    .replace(/^_/, "")
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function computeAgeDays(fm: MemoryFrontmatter, mtime: Date): number | null {
  const verified = fm.last_verified;
  const base = verified ? new Date(verified) : mtime;
  if (Number.isNaN(base.getTime())) return null;
  return Math.floor((Date.now() - base.getTime()) / 86_400_000);
}

// =====================================================
// Frontmatter parser/renderer (lightweight YAML — no deps)
// =====================================================

export function parseFrontmatter(raw: string): {
  frontmatter: MemoryFrontmatter;
  body: string;
} {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yaml = raw.slice(4, end);
  const after = raw.slice(end + 4).replace(/^\n+/, "");
  const fm = parseSimpleYaml(yaml);
  return { frontmatter: fm, body: after };
}

export function renderFrontmatter(fm: MemoryFrontmatter): string {
  const lines: string[] = ["---"];
  // Order important keys first
  const order = ["title", "scope", "status", "last_verified", "related"];
  const seen = new Set<string>();
  for (const k of order) {
    if (k in fm) {
      lines.push(yamlLine(k, (fm as Record<string, unknown>)[k]));
      seen.add(k);
    }
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k)) lines.push(yamlLine(k, (fm as Record<string, unknown>)[k]));
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlLine(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return `${key}: [${value.map((v) => yamlScalar(v)).join(", ")}]`;
  }
  if (value === null || value === undefined) return `${key}: null`;
  if (typeof value === "object") return `${key}: ${JSON.stringify(value)}`;
  return `${key}: ${yamlScalar(value)}`;
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    // Quote if it looks risky
    if (
      /[:#\-\[\]\{\},&\*!|>'"%@`]/.test(v) ||
      v === "true" ||
      v === "false" ||
      v === "null" ||
      /^\s|\s$/.test(v) ||
      /^\d/.test(v)
    ) {
      return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return v;
  }
  return String(v);
}

function parseSimpleYaml(s: string): MemoryFrontmatter {
  const out: MemoryFrontmatter = {};
  for (const rawLine of s.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const valRaw = m[2]!.trim();
    out[key] = parseYamlValue(valRaw);
  }
  return out;
}

function parseYamlValue(v: string): unknown {
  if (v === "" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner).map((item) => parseYamlValue(item.trim()));
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const c of s) {
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

export const RESERVED_MEMORY_NAMES = RESERVED_NAMES;
