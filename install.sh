#!/usr/bin/env bash
set -euo pipefail

# --- bootstrap: allow `curl ... | bash` remote invocation ---
# When piped to bash, BASH_SOURCE[0] is empty and the script has no on-disk
# location, so it cannot locate the bundled skills/ directory next to itself.
# Fetch the repo tarball into a temp dir and re-exec the real install.sh
# with all original arguments. Local `./install.sh` is unaffected.
if [[ -z "${BASH_SOURCE[0]:-}" ]]; then
  for dep in curl tar; do
    if ! command -v "$dep" >/dev/null 2>&1; then
      echo "Remote install requires '$dep' in PATH. Install it and re-run," >&2
      echo "or clone the repo and run ./install.sh directly." >&2
      exit 1
    fi
  done
  REMOTE_TARBALL="https://github.com/lhanyun/taskforce/archive/refs/heads/main.tar.gz"
  BOOTSTRAP_TMP="$(mktemp -d)"
  trap 'rm -rf "$BOOTSTRAP_TMP"' EXIT
  echo "Fetching Taskforce from $REMOTE_TARBALL …" >&2
  curl -fsSL "$REMOTE_TARBALL" -o "$BOOTSTRAP_TMP/repo.tar.gz"
  tar -xzf "$BOOTSTRAP_TMP/repo.tar.gz" -C "$BOOTSTRAP_TMP"
  exec bash "$BOOTSTRAP_TMP/taskforce-main/install.sh" "$@"
fi
# --- end bootstrap ---

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT=""
SCOPE="global"
PROJECT_DIR="$PWD"
FORCE=0

usage() {
  cat <<'EOF'
Usage: ./install.sh --agent cursor|codex|opencode|claude-code|workbuddy [--scope project|global]
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

if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" && "$AGENT" != "claude-code" && "$AGENT" != "workbuddy" ]]; then
  echo "--agent must be cursor, codex, opencode, claude-code, or workbuddy" >&2
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
    workbuddy) PARENT="$PROJECT_DIR/.workbuddy/skills" ;;
  esac
else
  case "$AGENT" in
    cursor) PARENT="${CURSOR_HOME:-$HOME/.cursor}/skills" ;;
    codex) PARENT="${CODEX_HOME:-$HOME/.codex}/skills" ;;
    opencode) PARENT="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/skills" ;;
    claude-code) PARENT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
    workbuddy) PARENT="${WORKBUDDY_HOME:-$HOME/.workbuddy}/skills" ;;
  esac
fi

TARGET="$PARENT/taskforce"
case "$TARGET" in
  */skills/taskforce) ;;
  *) echo "Refusing unsafe destination: $TARGET" >&2; exit 2 ;;
esac

# Preserve host-managed metadata (e.g. workbuddy's _user_meta.json) across --force replacement.
PRESERVED_META=""
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "Refusing to overwrite existing Taskforce skill: $TARGET" >&2
    echo "Re-run with --force to replace this exact destination." >&2
    exit 3
  fi
  if [[ -f "$TARGET/_user_meta.json" ]]; then
    PRESERVED_META=$(mktemp)
    cp -- "$TARGET/_user_meta.json" "$PRESERVED_META"
  fi
  rm -rf -- "$TARGET"
fi

mkdir -p -- "$PARENT"
cp -R -- "$ROOT/skills/taskforce" "$TARGET"

if [[ -n "$PRESERVED_META" ]]; then
  cp -- "$PRESERVED_META" "$TARGET/_user_meta.json"
  rm -f -- "$PRESERVED_META"
fi

echo "Installed the complete Taskforce skill to $TARGET"
echo "Next: reload your agent host and invoke Taskforce in a project."
echo "First use will run doctor, role CLI/model confirmation, cmux checks, and preflight."
