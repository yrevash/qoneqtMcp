import { readFile } from "node:fs/promises";
import { Glob } from "bun";
import { resolve } from "node:path";
import {
  gitBlamePorcelain,
  gitLogForFile,
  gitShow,
  isBotAuthor,
  isGitRepo,
  type BlameCommit,
  type CommitMeta,
} from "../lib/git.ts";
import {
  detectRepoIdentity,
  fetchPRsForCommit,
  type PRInfo,
} from "../lib/github.ts";
import type { Store } from "../index/store.ts";
import type { LLMProvider } from "../lib/llm.ts";

const MIN_BLAME_FOR_FOLLOW_FALLBACK = 3;
const MAX_COMMITS_KEPT = 8;
const MAX_PR_BODY_CHARS = 500;
const MAX_ISSUE_BODY_CHARS = 400;
const COMMENT_LOOKBEHIND_LINES = 15;
const RECENCY_HALF_LIFE_DAYS = 180;
const MARKER_RE = /\b(TODO|FIXME|HACK|XXX|NOTE|WHY)\b[:\s].{0,200}/gi;

export interface ExplainWhyOpts {
  workspace: string;
  store: Store;
  llm: LLMProvider | null;
}

export async function explainWhyTool(
  ctx: ExplainWhyOpts,
  args: {
    path?: string;
    symbol?: string;
    line_range?: { start: number; end: number };
    summarize?: boolean;
    max_commits?: number;
  },
): Promise<string> {
  if (!isGitRepo(ctx.workspace)) {
    return `not a git repo: ${ctx.workspace}\nexplain_why requires a git history.`;
  }

  // Resolve path + line range from args.symbol if needed
  const target = await resolveTarget(ctx.store, args);
  if (!target.ok) return target.message;
  const { filePath, startLine, endLine } = target;

  const notes: string[] = [];

  // Stage 1: Local-deterministic
  const blame = await gitBlamePorcelain(
    ctx.workspace,
    filePath,
    startLine,
    endLine,
  ).catch((err) => {
    notes.push(`blame failed: ${(err as Error).message}`);
    return null;
  });
  if (!blame) {
    return `git blame failed for ${filePath}:${startLine}-${endLine}\nthis can happen on uncommitted files or when the line range is invalid.`;
  }

  // Optionally fall back to log --follow for sparse blame
  let extraSHAs: string[] = [];
  if (blame.commits.length < MIN_BLAME_FOR_FOLLOW_FALLBACK) {
    notes.push(
      `sparse blame (${blame.commits.length} commits) — augmenting with file history`,
    );
    const log = await gitLogForFile(ctx.workspace, filePath, {
      follow: true,
      limit: 20,
    });
    if (log.length < MIN_BLAME_FOR_FOLLOW_FALLBACK) {
      notes.push(
        `--follow returned only ${log.length} commits — falling back to plain log`,
      );
      const plain = await gitLogForFile(ctx.workspace, filePath, {
        follow: false,
        limit: 20,
      });
      extraSHAs = plain.map((c) => c.sha);
    } else {
      extraSHAs = log.map((c) => c.sha);
    }
  }

  // Read the source file once for nearby comments + markers
  const fileText = await readFile(resolve(ctx.workspace, filePath), "utf8").catch(
    () => null,
  );
  const fileLines = fileText ? fileText.split("\n") : null;

  // Stage 1.3 — markers within and around the range
  const markers = collectMarkers(fileLines, startLine, endLine);

  // Stage 1.4 — nearest comment block above
  const commentAbove = collectCommentAbove(fileLines, startLine);

  // Stage 1.5 — ADRs touching this file/symbol (best-effort glob)
  const adrs = await collectADRs(ctx.workspace, filePath, args.symbol);

  // Stage 2 — `git show` for each unique SHA (blame + extras)
  const seen = new Set<string>();
  const allSHAs: string[] = [];
  for (const c of blame.commits) {
    if (!seen.has(c.sha)) {
      seen.add(c.sha);
      allSHAs.push(c.sha);
    }
  }
  for (const sha of extraSHAs) {
    if (!seen.has(sha)) {
      seen.add(sha);
      allSHAs.push(sha);
    }
  }
  const commitMetas = await Promise.all(
    allSHAs.map((sha) =>
      gitShow(ctx.workspace, sha).catch(() => null),
    ),
  );
  const commits: CommitMeta[] = commitMetas.filter((c): c is CommitMeta => c !== null);

  // Stage 3 — PR enrichment (best-effort)
  const repo = await detectRepoIdentity(ctx.workspace);
  const prMap = new Map<string, PRInfo[]>();
  if (repo) {
    await Promise.all(
      commits.map(async (c) => {
        const prs = await fetchPRsForCommit(ctx.workspace, repo, c.sha).catch(
          () => [],
        );
        if (prs.length) prMap.set(c.sha, prs);
      }),
    );
  } else {
    notes.push(
      "no GitHub origin detected — skipping PR/issue enrichment",
    );
  }

  // Stage 4 — Ranking
  const blameByShas = new Map<string, BlameCommit>();
  for (const b of blame.commits) blameByShas.set(b.sha, b);
  const ranked = rankCommits(commits, blameByShas, prMap);
  const maxKeep = Math.min(args.max_commits ?? MAX_COMMITS_KEPT, MAX_COMMITS_KEPT);
  const top = ranked.slice(0, maxKeep);

  // Stage 5 — optional LLM narrative
  let narrative: string | null = null;
  if (args.summarize && ctx.llm) {
    try {
      narrative = await runSummarize(ctx.llm, {
        path: filePath,
        startLine,
        endLine,
        commits: top,
        prMap,
        commentAbove,
        markers,
        adrs,
      });
    } catch (err) {
      notes.push(`summarize failed: ${(err as Error).message}`);
    }
  } else if (args.summarize && !ctx.llm) {
    notes.push(
      "summarize requested but no LLM provider configured (set ANTHROPIC_API_KEY)",
    );
  }

  return formatExplain({
    filePath,
    startLine,
    endLine,
    blameCommits: blame.commits,
    commits: top,
    prMap,
    commentAbove,
    markers,
    adrs,
    notes,
    narrative,
    repo,
  });
}

// =====================================================
// Target resolution
// =====================================================

async function resolveTarget(
  store: Store,
  args: { path?: string; symbol?: string; line_range?: { start: number; end: number } },
): Promise<
  | { ok: true; filePath: string; startLine: number; endLine: number }
  | { ok: false; message: string }
> {
  if (args.symbol) {
    const matches = store.findSymbolsByName(args.symbol);
    if (matches.length === 0) {
      return { ok: false, message: `no symbol named "${args.symbol}". try find_symbol with prefix=true.` };
    }
    const first = matches[0]!;
    return {
      ok: true,
      filePath: first.file_path,
      startLine: first.start_line,
      endLine: first.end_line,
    };
  }
  if (args.path) {
    const range = args.line_range;
    if (!range) {
      // Default to whole file via blame on lines 1..lineCount; use a reasonable cap.
      const sym = store.outlineFile(args.path)[0];
      if (sym) {
        return {
          ok: true,
          filePath: args.path,
          startLine: sym.start_line,
          endLine: sym.end_line,
        };
      }
      return {
        ok: true,
        filePath: args.path,
        startLine: 1,
        endLine: 200,
      };
    }
    return {
      ok: true,
      filePath: args.path,
      startLine: range.start,
      endLine: range.end,
    };
  }
  return {
    ok: false,
    message:
      "explain_why requires either `symbol` or `path` (with optional `line_range`).",
  };
}

// =====================================================
// Local sources
// =====================================================

interface MarkerHit {
  line: number;
  kind: string;
  text: string;
}

function collectMarkers(
  fileLines: string[] | null,
  startLine: number,
  endLine: number,
): MarkerHit[] {
  if (!fileLines) return [];
  const out: MarkerHit[] = [];
  const from = Math.max(1, startLine - 5);
  const to = Math.min(fileLines.length, endLine + 5);
  for (let i = from; i <= to; i++) {
    const line = fileLines[i - 1];
    if (!line) continue;
    for (const m of line.matchAll(MARKER_RE)) {
      out.push({
        line: i,
        kind: (m[1] ?? "").toUpperCase(),
        text: m[0]!.trim(),
      });
    }
  }
  return out;
}

function collectCommentAbove(
  fileLines: string[] | null,
  startLine: number,
): string | null {
  if (!fileLines) return null;
  // Walk upward collecting consecutive comment lines (// or /* */ block).
  const buf: string[] = [];
  let i = startLine - 2; // line above startLine, 0-indexed
  let depth = 0;
  let stoppedAt = -1;
  for (let scanned = 0; i >= 0 && scanned < COMMENT_LOOKBEHIND_LINES; i--, scanned++) {
    const raw = fileLines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") {
      if (buf.length === 0) continue;
      stoppedAt = i;
      break;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.endsWith("*/")
    ) {
      buf.unshift(trimmed);
      if (trimmed.startsWith("/*")) depth = 0;
    } else {
      stoppedAt = i;
      break;
    }
  }
  if (depth !== 0) return null;
  if (buf.length === 0) return null;
  void stoppedAt;
  return buf.join("\n");
}

interface ADRHit {
  path: string;
  title: string;
  excerpt: string;
}

async function collectADRs(
  workspace: string,
  filePath: string,
  symbol?: string,
): Promise<ADRHit[]> {
  const out: ADRHit[] = [];
  const needle = symbol ?? filePath.split("/").pop() ?? "";
  if (!needle) return out;
  const glob = new Glob("docs/{adr,architecture,decisions,rfcs}/**/*.md");
  for await (const rel of glob.scan({ cwd: workspace, dot: false })) {
    let text: string;
    try {
      text = await readFile(resolve(workspace, rel), "utf8");
    } catch {
      continue;
    }
    if (!text.toLowerCase().includes(needle.toLowerCase())) continue;
    const titleMatch = text.match(/^#+\s+(.+)$/m);
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + 240);
    out.push({
      path: rel,
      title: titleMatch ? titleMatch[1]!.trim() : rel,
      excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
    });
    if (out.length >= 3) break;
  }
  return out;
}

// =====================================================
// Ranking
// =====================================================

function rankCommits(
  commits: CommitMeta[],
  blameByShas: Map<string, BlameCommit>,
  prMap: Map<string, PRInfo[]>,
): CommitMeta[] {
  const now = Date.now() / 1000;
  const half = RECENCY_HALF_LIFE_DAYS * 86400;
  const scored = commits.map((c) => {
    const tEpoch = Date.parse(c.authorDate) / 1000;
    const ageSecs = Math.max(0, now - (Number.isNaN(tEpoch) ? now : tEpoch));
    const recency = Math.pow(0.5, ageSecs / half); // 0..1
    const touched = blameByShas.get(c.sha)?.lineCount ?? 0;
    const touchedNorm = Math.min(1, touched / 20);
    const hasPR = (prMap.get(c.sha)?.length ?? 0) > 0 ? 1 : 0;
    const isBot = isBotAuthor(c.author, c.authorEmail) ? 0.6 : 1;
    const score = (0.5 * recency + 0.3 * touchedNorm + 0.2 * hasPR) * isBot;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Always include the oldest blame commit (origin story) if not in top.
  const blameOrder = [...blameByShas.keys()];
  if (blameOrder.length > 0) {
    const oldestSha = blameOrder
      .map((sha) => commits.find((c) => c.sha === sha))
      .filter((c): c is CommitMeta => !!c)
      .sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate))[0];
    if (oldestSha && !scored.slice(0, MAX_COMMITS_KEPT).find((s) => s.c.sha === oldestSha.sha)) {
      scored.splice(MAX_COMMITS_KEPT - 1, 0, { c: oldestSha, score: -1 });
    }
  }
  // Dedupe again preserving order
  const seen = new Set<string>();
  const out: CommitMeta[] = [];
  for (const s of scored) {
    if (seen.has(s.c.sha)) continue;
    seen.add(s.c.sha);
    out.push(s.c);
  }
  return out;
}

// =====================================================
// LLM summarize
// =====================================================

async function runSummarize(
  llm: LLMProvider,
  data: {
    path: string;
    startLine: number;
    endLine: number;
    commits: CommitMeta[];
    prMap: Map<string, PRInfo[]>;
    commentAbove: string | null;
    markers: MarkerHit[];
    adrs: ADRHit[];
  },
): Promise<string> {
  const evidence = formatEvidenceForLLM(data);
  const system = `You are a code-history analyst. Given git blame, commit messages, PRs, issues, comments, TODO markers, and ADRs about a specific code region, write a concise narrative explaining WHY the code exists (not what it does).
RULES:
- Cite specific commit SHAs (first 7 chars) and PR numbers in the narrative when making claims.
- Never invent reasons not directly supported by the evidence.
- If the evidence is sparse or contradictory, say so plainly.
- 4-8 sentences max. Plain prose. No bullet lists.`;
  const user = `Code region: ${data.path} lines ${data.startLine}–${data.endLine}\n\n${evidence}\n\nWrite the narrative now.`;
  const r = await llm.summarize(system, user);
  return r.text;
}

function formatEvidenceForLLM(data: {
  commits: CommitMeta[];
  prMap: Map<string, PRInfo[]>;
  commentAbove: string | null;
  markers: MarkerHit[];
  adrs: ADRHit[];
}): string {
  const lines: string[] = [];
  if (data.commentAbove) {
    lines.push(`COMMENT ABOVE:\n${data.commentAbove}\n`);
  }
  if (data.markers.length) {
    lines.push("MARKERS:");
    for (const m of data.markers) lines.push(`  L${m.line} ${m.kind}: ${m.text}`);
    lines.push("");
  }
  lines.push("COMMITS:");
  for (const c of data.commits) {
    lines.push(`- ${c.sha.slice(0, 7)} ${c.authorDate.slice(0, 10)} ${c.author}: ${c.subject}`);
    if (c.body.trim()) lines.push(`  body: ${truncate(c.body, MAX_PR_BODY_CHARS)}`);
    const prs = data.prMap.get(c.sha) ?? [];
    for (const pr of prs) {
      lines.push(`  PR #${pr.number}: ${pr.title}`);
      if (pr.body) lines.push(`    pr body: ${truncate(pr.body, MAX_PR_BODY_CHARS)}`);
      for (const iss of pr.closedIssues) {
        lines.push(`    closes #${iss.number}: ${iss.title ?? "(no title)"}`);
        if (iss.body) lines.push(`      issue body: ${truncate(iss.body, MAX_ISSUE_BODY_CHARS)}`);
      }
    }
  }
  if (data.adrs.length) {
    lines.push("\nADRs:");
    for (const a of data.adrs) lines.push(`- ${a.path}: ${a.title} — ${a.excerpt}`);
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// =====================================================
// Output formatting
// =====================================================

function formatExplain(data: {
  filePath: string;
  startLine: number;
  endLine: number;
  blameCommits: BlameCommit[];
  commits: CommitMeta[];
  prMap: Map<string, PRInfo[]>;
  commentAbove: string | null;
  markers: MarkerHit[];
  adrs: ADRHit[];
  notes: string[];
  narrative: string | null;
  repo: { owner: string; name: string; host: string } | null;
}): string {
  const lines: string[] = [];
  lines.push(`explain_why  ${data.filePath}:${data.startLine}-${data.endLine}`);
  if (data.repo) lines.push(`repo: ${data.repo.owner}/${data.repo.name} (${data.repo.host})`);
  lines.push("");

  if (data.narrative) {
    lines.push("narrative:");
    lines.push(data.narrative);
    lines.push("");
  }

  if (data.commentAbove) {
    lines.push("comment above:");
    for (const l of data.commentAbove.split("\n")) lines.push(`  ${l}`);
    lines.push("");
  }

  if (data.markers.length) {
    lines.push("markers:");
    for (const m of data.markers) lines.push(`  L${m.line}  ${m.kind}: ${m.text}`);
    lines.push("");
  }

  lines.push(`commits  (${data.commits.length} of ${data.blameCommits.length} blame-unique):`);
  for (const c of data.commits) {
    const prs = data.prMap.get(c.sha) ?? [];
    const prTag = prs.length ? `  PR #${prs.map((p) => p.number).join(",")}` : "";
    lines.push(
      `  ${c.sha.slice(0, 8)}  ${c.authorDate.slice(0, 10)}  ${c.author.padEnd(18).slice(0, 18)}${prTag}`,
    );
    lines.push(`    ${c.subject}`);
    if (c.body.trim()) {
      const trimmedBody = truncate(c.body.replace(/\n+/g, " "), 240);
      lines.push(`    ${trimmedBody}`);
    }
    for (const pr of prs) {
      lines.push(`    PR #${pr.number} ${pr.title}`);
      if (pr.body) {
        const t = truncate(pr.body.replace(/\n+/g, " "), 240);
        lines.push(`      ${t}`);
      }
      for (const iss of pr.closedIssues) {
        lines.push(`      closes #${iss.number}${iss.title ? ` — ${iss.title}` : ""}`);
      }
    }
  }
  if (data.adrs.length) {
    lines.push("");
    lines.push(`adrs  (${data.adrs.length}):`);
    for (const a of data.adrs) {
      lines.push(`  ${a.path} — ${a.title}`);
      lines.push(`    ${a.excerpt}`);
    }
  }
  if (data.notes.length) {
    lines.push("");
    lines.push("notes:");
    for (const n of data.notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
