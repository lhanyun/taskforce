#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT=""
SCOPE="global"
PROJECT_DIR="$PWD"
FORCE=0

usage() {
  cat <<'EOF'
Usage: ./install.sh --agent cursor|codex|opencode|claude-code [--scope project|global]
                    [--project PATH] [--force]

Copies the complete Taskforce skill. It does not configure project roles,
select models, change cmux settings, or launch agents.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --project) PROJECT_DIR="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" && "$AGENT" != "claude-code" ]]; then
  echo "--agent must be cursor, codex, opencode, or claude-code" >&2
  exit 2
fi
if [[ "$SCOPE" != "project" && "$SCOPE" != "global" ]]; then
  echo "--scope must be project or global" >&2
  exit 2
fi

if [[ "$SCOPE" == "project" ]]; then
  case "$AGENT" in
    cursor|codex|opencode) PARENT="$PROJECT_DIR/.agents/skills" ;;
    claude-code) PARENT="$PROJECT_DIR/.claude/skills" ;;
  esac
else
  case "$AGENT" in
    cursor) PARENT="${CURSOR_HOME:-$HOME/.cursor}/skills" ;;
    codex) PARENT="${CODEX_HOME:-$HOME/.codex}/skills" ;;
    opencode) PARENT="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/skills" ;;
    claude-code) PARENT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
  esac
fi

TARGET="$PARENT/taskforce"
case "$TARGET" in
  */skills/taskforce) ;;
  *) echo "Refusing unsafe destination: $TARGET" >&2; exit 2 ;;
esac

if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "Refusing to overwrite existing Taskforce skill: $TARGET" >&2
    echo "Re-run with --force to replace this exact destination." >&2
    exit 3
  fi
  rm -rf -- "$TARGET"
fi

mkdir -p -- "$PARENT"
cp -R -- "$ROOT/skills/taskforce" "$TARGET"

echo "Installed the complete Taskforce skill to $TARGET"
echo "Next: reload your agent host and invoke Taskforce in a project."
echo "First use will run doctor, role CLI/model confirmation, cmux checks, and preflight."
