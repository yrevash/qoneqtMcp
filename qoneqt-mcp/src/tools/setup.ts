/**
 * Setup tools: install git hooks into the workspace, print recommended .gitignore block.
 * Both safe to call repeatedly.
 */
import { spawn } from "bun";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const RECOMMENDED_GITIGNORE_BLOCK = `# qoneqt-mcp: ignore the local index + event log, COMMIT memories
.qoneqt-mcp/*
!.qoneqt-mcp/memories/
`;

export async function installHooksTool(args: {
  workspace: string;
}): Promise<string> {
  if (!existsSync(resolve(args.workspace, ".git"))) {
    return `not a git repo: ${args.workspace}\ninstall_hooks requires a git repository.`;
  }
  const installer = resolve(import.meta.dir, "../../scripts/install-git-hooks.sh");
  if (!existsSync(installer)) {
    return `installer not found at ${installer}; reinstall qoneqt-mcp.`;
  }
  const proc = spawn(["bash", installer, args.workspace], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return [
    `install_hooks ${args.workspace}  (exit=${code})`,
    "",
    out.trim(),
    err.trim() ? `\nstderr:\n${err.trim()}` : "",
    "",
    "Then add this to your workspace .gitignore (call gitignore_template tool to copy):",
    "",
    RECOMMENDED_GITIGNORE_BLOCK,
  ].join("\n");
}

export function gitignoreTemplateTool(): string {
  return [
    "Recommended .gitignore additions for a workspace using qoneqt-mcp:",
    "",
    RECOMMENDED_GITIGNORE_BLOCK,
    "Notes:",
    "  - The index (.qoneqt-mcp/<workspace>/index.sqlite) is local and not committed.",
    "  - The git-events log (.qoneqt-mcp/git-events.jsonl) is local and not committed.",
    "  - The memories/ folder IS committed so the team shares architecture / conventions /",
    "    gotchas / glossary entries via git PRs.",
  ].join("\n");
}
