#!/usr/bin/env bash
# Install qoneqt-mcp git hooks into a workspace's .git/hooks/.
# Idempotent. Backs up any pre-existing hooks once (.qoneqt-mcp.bak).
#
# usage:
#   bash scripts/install-git-hooks.sh /path/to/workspace
#
# After install, every commit/merge/branch-switch in the workspace appends
# JSONL events to <workspace>/.qoneqt-mcp/git-events.jsonl which the MCP
# server tails to populate the activity log.

set -euo pipefail

WS="${1:-}"
if [ -z "$WS" ]; then
  echo "usage: $0 <workspace>"
  exit 1
fi
if [ ! -d "$WS/.git" ]; then
  echo "not a git repo: $WS"
  exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)/hooks"
DST="$WS/.git/hooks"

mkdir -p "$DST"

for hook in post-commit post-merge post-checkout; do
  src_file="$SRC/$hook"
  dst_file="$DST/$hook"

  if [ ! -f "$src_file" ]; then
    echo "[skip] no template for $hook"
    continue
  fi

  if [ -f "$dst_file" ] && ! grep -q 'qoneqt-mcp' "$dst_file" 2>/dev/null; then
    echo "[backup] $dst_file → $dst_file.qoneqt-mcp.bak"
    mv "$dst_file" "$dst_file.qoneqt-mcp.bak"
  fi

  cp "$src_file" "$dst_file"
  chmod +x "$dst_file"
  echo "[install] $dst_file"
done

mkdir -p "$WS/.qoneqt-mcp"
touch "$WS/.qoneqt-mcp/git-events.jsonl"

cat <<EOF

[ok] hooks installed at $DST
[ok] events file: $WS/.qoneqt-mcp/git-events.jsonl

Recommended .gitignore for $WS (run \`bun run gitignore-template\` to print):

  # qoneqt-mcp: ignore the local index + event log, COMMIT memories
  .qoneqt-mcp/*
  !.qoneqt-mcp/memories/

EOF
