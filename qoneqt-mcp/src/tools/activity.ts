import type { Store } from "../index/store.ts";
import type { ActivityRow } from "../lib/types.ts";

const SECONDS_PER_DAY = 86400;

export function recentActivityTool(
  store: Store,
  args: {
    user?: string;
    file?: string;
    source?: string;
    since_days?: number;
    limit?: number;
  },
): string {
  const since =
    args.since_days != null
      ? Math.floor(Date.now() / 1000) - args.since_days * SECONDS_PER_DAY
      : undefined;
  const rows = store.recentActivity({
    user: args.user,
    file: args.file,
    source: args.source,
    since,
    limit: args.limit ?? 50,
  });
  return formatActivityRows(rows, {
    title: "recent_activity",
    user: args.user,
    file: args.file,
    source: args.source,
    sinceDays: args.since_days,
  });
}

export function whoTouchedTool(
  store: Store,
  args: { file: string; since_days?: number; limit?: number },
): string {
  const sinceDays = args.since_days ?? 90;
  const since = Math.floor(Date.now() / 1000) - sinceDays * SECONDS_PER_DAY;
  const rows = store.fileTouchersSince(args.file, since, args.limit ?? 20);
  if (rows.length === 0) {
    return `who_touched ${args.file} (last ${sinceDays}d): no activity logged.\n(this requires the watcher and/or git hooks to have been running)`;
  }
  const lines = [
    `who_touched ${args.file}  (last ${sinceDays}d, ${rows.length} contributor(s))`,
    "",
  ];
  for (const r of rows) {
    const ago = humanAgo(Math.floor(Date.now() / 1000) - r.last_ts);
    lines.push(
      `  ${r.user.padEnd(24).slice(0, 24)} ${r.email ? r.email.padEnd(28).slice(0, 28) : "".padEnd(28)} actions=${r.actions.toString().padStart(4)}  last=${ago}`,
    );
  }
  return lines.join("\n");
}

export function whatDidUserDoTool(
  store: Store,
  args: { user: string; since_days?: number; limit?: number },
): string {
  const sinceDays = args.since_days ?? 14;
  const since = Math.floor(Date.now() / 1000) - sinceDays * SECONDS_PER_DAY;
  const rows = store.userFilesTouched(args.user, since, args.limit ?? 50);
  if (rows.length === 0) {
    return `what_did_user_do ${args.user} (last ${sinceDays}d): no activity logged for this user.`;
  }
  const lines = [
    `what_did_user_do ${args.user}  (last ${sinceDays}d, ${rows.length} file(s))`,
    "",
  ];
  for (const r of rows) {
    const ago = humanAgo(Math.floor(Date.now() / 1000) - r.last_ts);
    lines.push(
      `  ${r.file_path.padEnd(60).slice(0, 60)}  actions=${r.actions.toString().padStart(3)}  last=${ago}`,
    );
  }
  return lines.join("\n");
}

function formatActivityRows(
  rows: ActivityRow[],
  meta: {
    title: string;
    user?: string;
    file?: string;
    source?: string;
    sinceDays?: number;
  },
): string {
  if (rows.length === 0) {
    return `${meta.title}: no activity${formatFilters(meta)}.\n(activity is logged by the file watcher and the git hooks; install hooks via \`bun run install-hooks\`)`;
  }
  const lines = [
    `${meta.title}${formatFilters(meta)}: ${rows.length} entries`,
    "",
  ];
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    const ago = humanAgo(now - r.ts);
    const path = r.file_path ?? "(no path)";
    const ref = r.ref ? `  ref=${r.ref.slice(0, 8)}` : "";
    const detail = r.detail ? `  ${r.detail}` : "";
    lines.push(
      `  ${ago.padEnd(8)} ${r.source.padEnd(8)} ${r.action.padEnd(11)} ${r.user.padEnd(20).slice(0, 20)} ${path}${ref}${detail}`,
    );
  }
  return lines.join("\n");
}

function formatFilters(meta: {
  user?: string;
  file?: string;
  source?: string;
  sinceDays?: number;
}): string {
  const parts: string[] = [];
  if (meta.user) parts.push(`user=${meta.user}`);
  if (meta.file) parts.push(`file~${meta.file}`);
  if (meta.source) parts.push(`source=${meta.source}`);
  if (meta.sinceDays) parts.push(`since=${meta.sinceDays}d`);
  return parts.length ? ` (${parts.join(" ")})` : "";
}

function humanAgo(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d`;
  if (secs < 86400 * 365) return `${Math.floor(secs / (86400 * 30))}mo`;
  return `${Math.floor(secs / (86400 * 365))}y`;
}
