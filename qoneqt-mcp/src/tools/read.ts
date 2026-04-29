import { resolve, isAbsolute } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { Glob } from "bun";

const MAX_LINES_DEFAULT = 400;
const MAX_LINES_HARD_CAP = 2000;

export async function readFileTool(
  workspace: string,
  args: { path: string; start_line?: number; end_line?: number; max_lines?: number },
): Promise<string> {
  const abs = resolveInside(workspace, args.path);
  const stats = await stat(abs);
  if (!stats.isFile()) return `error: not a file: ${args.path}`;

  const content = await readFile(abs, "utf8");
  const lines = content.split("\n");
  const total = lines.length;

  const max = Math.min(args.max_lines ?? MAX_LINES_DEFAULT, MAX_LINES_HARD_CAP);
  const start = Math.max(1, args.start_line ?? 1);
  const naturalEnd = args.end_line ?? Math.min(total, start + max - 1);
  const end = Math.min(total, naturalEnd, start + max - 1);

  const slice = lines.slice(start - 1, end);
  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(5, " ")} | ${line}`)
    .join("\n");

  const header = `${args.path}  (lines ${start}-${end} of ${total})`;
  const truncatedNote =
    end < total
      ? `\n\n... ${total - end} more lines. Call read_file again with start_line=${end + 1} to continue.`
      : "";

  return `${header}\n${numbered}${truncatedNote}`;
}

export async function listFilesTool(
  workspace: string,
  args: { pattern?: string; max?: number },
): Promise<string> {
  const pattern = args.pattern ?? "src/**/*.{js,jsx,ts,tsx}";
  const max = Math.min(args.max ?? 200, 2000);
  const glob = new Glob(pattern);

  const matches: string[] = [];
  for await (const m of glob.scan({ cwd: workspace, dot: false })) {
    matches.push(m);
    if (matches.length >= max) break;
  }
  matches.sort();

  return `pattern: ${pattern}\nmatches: ${matches.length}${matches.length >= max ? " (truncated)" : ""}\n${matches.join("\n")}`;
}

function resolveInside(workspace: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(workspace, p);
  if (!abs.startsWith(workspace)) {
    throw new Error(`path outside workspace: ${p}`);
  }
  return abs;
}
