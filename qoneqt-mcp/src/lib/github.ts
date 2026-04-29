import { spawn } from "bun";
import { gitOriginUrl } from "./git.ts";

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  mergedAt: string | null;
  closedIssues: { number: number; title?: string; body?: string }[];
}

export interface RepoIdentity {
  owner: string;
  name: string;
  host: string; // github.com etc.
}

const prCache = new Map<string, PRInfo[] | null>();
const issueCache = new Map<string, { title: string; body: string } | null>();

let ghAvailable: boolean | null = null;
export async function isGhAvailable(): Promise<boolean> {
  if (ghAvailable !== null) return ghAvailable;
  ghAvailable = Bun.which("gh") != null;
  return ghAvailable;
}

export async function detectRepoIdentity(workspace: string): Promise<RepoIdentity | null> {
  const url = await gitOriginUrl(workspace);
  if (!url) return null;
  const ssh = url.match(/^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/);
  if (ssh) {
    return { host: ssh[1]!, owner: ssh[2]!, name: ssh[3]! };
  }
  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(\.git)?(?:\/)?$/);
  if (https) {
    return { host: https[1]!, owner: https[2]!, name: https[3]! };
  }
  return null;
}

export async function fetchPRsForCommit(
  workspace: string,
  repo: RepoIdentity,
  sha: string,
): Promise<PRInfo[]> {
  const key = `${repo.owner}/${repo.name}@${sha}`;
  if (prCache.has(key)) return prCache.get(key)!;

  const usingGh = await isGhAvailable();
  let prs: PRInfo[] | null = null;
  try {
    prs = usingGh
      ? await fetchPRsViaGh(workspace, repo, sha)
      : await fetchPRsViaRest(repo, sha);
  } catch {
    prs = null;
  }

  if (prs) {
    // Enrich with closed issues
    for (const pr of prs) {
      const refs = extractClosedIssueNumbers(pr.body);
      for (const num of refs) {
        const issueKey = `${repo.owner}/${repo.name}#${num}`;
        if (!issueCache.has(issueKey)) {
          try {
            const iss = usingGh
              ? await fetchIssueViaGh(workspace, repo, num)
              : await fetchIssueViaRest(repo, num);
            issueCache.set(issueKey, iss);
          } catch {
            issueCache.set(issueKey, null);
          }
        }
        const info = issueCache.get(issueKey);
        if (info) {
          pr.closedIssues.push({ number: num, title: info.title, body: info.body });
        } else {
          pr.closedIssues.push({ number: num });
        }
      }
    }
  }

  prCache.set(key, prs);
  return prs ?? [];
}

// =====================================================
// gh CLI path
// =====================================================

async function fetchPRsViaGh(
  workspace: string,
  repo: RepoIdentity,
  sha: string,
): Promise<PRInfo[]> {
  const path = `repos/${repo.owner}/${repo.name}/commits/${sha}/pulls`;
  const proc = spawn(["gh", "api", path], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return [];
  const arr = JSON.parse(out) as Array<Record<string, unknown>>;
  return arr.map((pr) => ({
    number: pr.number as number,
    title: (pr.title as string) ?? "",
    body: ((pr.body as string) ?? "").trim(),
    state: (pr.state as string) ?? "",
    url: (pr.html_url as string) ?? "",
    mergedAt: ((pr.merged_at as string) ?? null) || null,
    closedIssues: [],
  }));
}

async function fetchIssueViaGh(
  workspace: string,
  repo: RepoIdentity,
  num: number,
): Promise<{ title: string; body: string }> {
  const proc = spawn(
    ["gh", "api", `repos/${repo.owner}/${repo.name}/issues/${num}`],
    { cwd: workspace, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh issue ${num} failed`);
  const obj = JSON.parse(out) as { title?: string; body?: string };
  return { title: obj.title ?? "", body: (obj.body ?? "").trim() };
}

// =====================================================
// REST fallback (uses GITHUB_TOKEN if set)
// =====================================================

async function fetchPRsViaRest(repo: RepoIdentity, sha: string): Promise<PRInfo[]> {
  const url = `https://api.${repo.host}/repos/${repo.owner}/${repo.name}/commits/${sha}/pulls`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return [];
  const arr = (await res.json()) as Array<Record<string, unknown>>;
  return arr.map((pr) => ({
    number: pr.number as number,
    title: (pr.title as string) ?? "",
    body: ((pr.body as string) ?? "").trim(),
    state: (pr.state as string) ?? "",
    url: (pr.html_url as string) ?? "",
    mergedAt: ((pr.merged_at as string) ?? null) || null,
    closedIssues: [],
  }));
}

async function fetchIssueViaRest(
  repo: RepoIdentity,
  num: number,
): Promise<{ title: string; body: string }> {
  const url = `https://api.${repo.host}/repos/${repo.owner}/${repo.name}/issues/${num}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`rest issue ${num} failed`);
  const obj = (await res.json()) as { title?: string; body?: string };
  return { title: obj.title ?? "", body: (obj.body ?? "").trim() };
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

const CLOSE_KEYWORDS_RE =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:#|GH-)?(\d+)/gi;

export function extractClosedIssueNumbers(body: string): number[] {
  const nums = new Set<number>();
  for (const m of body.matchAll(CLOSE_KEYWORDS_RE)) {
    const n = parseInt(m[2]!, 10);
    if (!Number.isNaN(n)) nums.add(n);
  }
  return [...nums];
}
