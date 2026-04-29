import { spawn } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface BlameLineEntry {
  sha: string;
  origLine: number;
  finalLine: number;
  author: string;
  authorMail: string;
  authorTime: number;
  authorTz: string;
  summary: string;
  filename: string;
  text: string;
}

export interface CommitMeta {
  sha: string;
  author: string;
  authorEmail: string;
  authorDate: string; // ISO
  subject: string;
  body: string;
  coAuthors: { name: string; email: string }[];
}

export interface BlameSummary {
  /** Unique commits within the line range, ordered by first appearance. */
  commits: BlameCommit[];
  /** Line-by-line blame, in source order. */
  lines: BlameLineEntry[];
}

export interface BlameCommit {
  sha: string;
  lineCount: number;
  oldestLine: number;
  author: string;
  authorTime: number;
  summary: string;
}

export function isGitRepo(workspace: string): boolean {
  return existsSync(resolve(workspace, ".git"));
}

export async function gitBlamePorcelain(
  workspace: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<BlameSummary> {
  const args = [
    "blame",
    "--line-porcelain",
    "-L",
    `${startLine},${endLine}`,
    "--",
    filePath,
  ];
  const { stdout, code, stderr } = await runGit(workspace, args);
  if (code !== 0) {
    throw new Error(`git blame failed (${code}): ${stderr.trim()}`);
  }
  return parseLinePorcelain(stdout);
}

export async function gitShow(workspace: string, sha: string): Promise<CommitMeta> {
  // Use a unique delimiter unlikely to appear in commit bodies.
  const FORMAT = "%H%n%an%n%ae%n%aI%n%s%n%b%n--QONEQT-EOC--";
  const { stdout, code, stderr } = await runGit(workspace, [
    "show",
    "--no-patch",
    `--format=${FORMAT}`,
    sha,
  ]);
  if (code !== 0) {
    throw new Error(`git show ${sha} failed (${code}): ${stderr.trim()}`);
  }
  const body = stdout.split("--QONEQT-EOC--")[0]!;
  const [shaOut = "", author = "", authorEmail = "", authorDate = "", subject = "", ...rest] =
    body.split("\n");
  const fullBody = rest.join("\n").replace(/\n+$/, "");
  return {
    sha: shaOut,
    author,
    authorEmail,
    authorDate,
    subject,
    body: stripCoAuthors(fullBody),
    coAuthors: extractCoAuthors(fullBody),
  };
}

export async function gitLogForFile(
  workspace: string,
  filePath: string,
  opts: { limit?: number; follow?: boolean } = {},
): Promise<{ sha: string; author: string; date: string; subject: string }[]> {
  const limit = opts.limit ?? 50;
  const args = [
    "log",
    "--no-merges",
    ...(opts.follow ? ["--follow", "-M30%"] : []),
    `-n`,
    String(limit),
    "--pretty=format:%H\t%an\t%aI\t%s",
    "--",
    filePath,
  ];
  const { stdout, code } = await runGit(workspace, args);
  if (code !== 0) return [];
  const out: { sha: string; author: string; date: string; subject: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [sha = "", author = "", date = "", ...rest] = line.split("\t");
    if (!sha) continue;
    out.push({ sha, author, date, subject: rest.join("\t") });
  }
  return out;
}

export async function gitOriginUrl(workspace: string): Promise<string | null> {
  const { stdout, code } = await runGit(workspace, ["remote", "get-url", "origin"]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

export interface GitUser {
  name: string;
  email: string | null;
}

/**
 * Read the local git user identity. Used to attribute activity entries to a dev.
 * Falls back to OS user if git config is missing.
 */
export async function readGitConfigUser(workspace: string): Promise<GitUser> {
  const [nameRes, emailRes] = await Promise.all([
    runGit(workspace, ["config", "user.name"]),
    runGit(workspace, ["config", "user.email"]),
  ]);
  let name = nameRes.code === 0 ? nameRes.stdout.trim() : "";
  const email = emailRes.code === 0 ? emailRes.stdout.trim() || null : null;
  if (!name) {
    name = process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
  return { name, email };
}

export async function gitCurrentBranch(workspace: string): Promise<string | null> {
  const { stdout, code } = await runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

export async function gitHeadSha(workspace: string): Promise<string | null> {
  const { stdout, code } = await runGit(workspace, ["rev-parse", "HEAD"]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

// =====================================================
// Parsers + helpers
// =====================================================

const CO_AUTHOR_RE =
  /^Co-Authored-By:\s*([^<]+?)\s*<([^>]+)>\s*$/gim;

const BOT_CO_AUTHORS = [
  "claude",
  "copilot",
  "codex",
  "github-actions",
  "dependabot",
  "renovate",
];

export function isBotAuthor(author: string, email: string = ""): boolean {
  const lc = `${author.toLowerCase()} ${email.toLowerCase()}`;
  return BOT_CO_AUTHORS.some((b) => lc.includes(b));
}

function extractCoAuthors(body: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const m of body.matchAll(CO_AUTHOR_RE)) {
    const name = (m[1] ?? "").trim();
    const email = (m[2] ?? "").trim();
    if (name) out.push({ name, email });
  }
  return out;
}

function stripCoAuthors(body: string): string {
  return body.replace(CO_AUTHOR_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function parseLinePorcelain(text: string): BlameSummary {
  const lines: BlameLineEntry[] = [];
  const headerCache = new Map<string, Partial<BlameLineEntry>>();
  const raw = text.split("\n");
  let i = 0;
  while (i < raw.length) {
    const headerLine = raw[i] ?? "";
    if (!headerLine) {
      i++;
      continue;
    }
    const headerMatch = headerLine.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
    if (!headerMatch) {
      i++;
      continue;
    }
    const sha = headerMatch[1]!;
    const origLine = parseInt(headerMatch[2]!, 10);
    const finalLine = parseInt(headerMatch[3]!, 10);
    const cached = headerCache.get(sha) ?? {};
    const entry: Partial<BlameLineEntry> = { ...cached, sha, origLine, finalLine };
    i++;
    while (i < raw.length) {
      const line = raw[i] ?? "";
      if (line.startsWith("\t")) {
        entry.text = line.slice(1);
        i++;
        break;
      }
      if (line === "") {
        i++;
        break;
      }
      const spaceIdx = line.indexOf(" ");
      const k = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
      const v = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
      switch (k) {
        case "author":
          entry.author = v;
          break;
        case "author-mail":
          entry.authorMail = v.replace(/^<|>$/g, "");
          break;
        case "author-time":
          entry.authorTime = parseInt(v, 10);
          break;
        case "author-tz":
          entry.authorTz = v;
          break;
        case "summary":
          entry.summary = v;
          break;
        case "filename":
          entry.filename = v;
          break;
        // ignore committer-* and other fields
      }
      i++;
    }
    if (entry.sha && entry.text != null) {
      lines.push(entry as BlameLineEntry);
      headerCache.set(entry.sha, {
        author: entry.author,
        authorMail: entry.authorMail,
        authorTime: entry.authorTime,
        authorTz: entry.authorTz,
        summary: entry.summary,
        filename: entry.filename,
      });
    }
  }

  // Aggregate by SHA preserving order of first appearance.
  const order: string[] = [];
  const agg = new Map<string, BlameCommit>();
  for (const l of lines) {
    const cur = agg.get(l.sha);
    if (!cur) {
      order.push(l.sha);
      agg.set(l.sha, {
        sha: l.sha,
        lineCount: 1,
        oldestLine: l.finalLine,
        author: l.author ?? "",
        authorTime: l.authorTime ?? 0,
        summary: l.summary ?? "",
      });
    } else {
      cur.lineCount++;
      cur.oldestLine = Math.min(cur.oldestLine, l.finalLine);
    }
  }
  return {
    commits: order.map((sha) => agg.get(sha)!),
    lines,
  };
}

async function runGit(
  workspace: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawn(["git", ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}
