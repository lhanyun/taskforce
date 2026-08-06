# Install Path Unification — Design

- **Date**: 2026-07-30
- **Status**: Approved (pending spec review)
- **Scope**: Installation path alignment between `npx skills add`, `install.sh`/`install.ps1`, and plugin manifests
- **Compatibility**: **Breaking** — no backward-compatibility shims for old `.cursor/skills/`, `.codex/skills/`, `.opencode/skills/` project-scope paths. One-time clean fix.

## Problem Statement

Taskforce currently has three installation entry points whose behavior diverges:

1. **`npx skills add <owner>/taskforce`** (recommended) — the vercel-labs/skills CLI. Project scope installs to `.agents/skills/` (for cursor/codex/opencode) or `.claude/skills/` (for claude-code), per the AGENTS.md standard.
2. **`install.sh` / `install.ps1`** (offline fallback) — project scope installs to per-agent `.cursor/skills/`, `.codex/skills/`, `.opencode/skills/`. **Diverges from `npx skills`.**
3. **`.xxx-plugin/plugin.json`** (marketplace discovery) — incomplete: `.claude-plugin/` and `.cursor-plugin/` lack the `skills` field and have inconsistent content vs `.codex-plugin/`.

Concrete issues:

- **Project-scope path mismatch**: two installers produce different results; `npx skills update` cannot find skills installed by `install.sh`, and vice versa.
- **`--skill taskforce` is redundant** for a single-skill repo but the README hardcodes it everywhere, obscuring the simpler form.
- **`claude-code` agent unsupported** by `install.sh` despite being a first-class agent in `npx skills` and having a `.claude-plugin/` manifest.
- **Plugin manifests inconsistent** across the three hosts (codex complete; claude/cursor stubs).

## Goals

1. `install.sh`/`install.ps1` project-scope paths **identical** to `npx skills add`.
2. `install.sh`/`install.ps1` support `claude-code` as a first-class agent.
3. README presents three install entry points clearly with a path reference table; `--skill` shown as optional (CI-only).
4. All three plugin manifests share one complete, consistent structure.
5. Tests cover the new paths and the claude-code agent.

## Non-Goals

- Changing `npx skills add` behavior (third-party CLI, out of scope).
- Removing `install.sh`/`install.ps1` (offline/air-gapped install remains a supported use case).
- Adding `.claude-plugin/marketplace.json` (single-plugin repos use `plugin.json`).
- Migrating users who installed via the old `install.sh` paths (breaking change; documented in README).

## Design

### 1. Unified Path Table

**Project scope** (relative to target project root):

| Agent | New path | Matches `npx skills` |
|-------|----------|----------------------|
| cursor | `.agents/skills/taskforce/` | ✅ |
| codex | `.agents/skills/taskforce/` | ✅ |
| opencode | `.agents/skills/taskforce/` | ✅ |
| claude-code | `.claude/skills/taskforce/` | ✅ |

**Global scope** (unchanged, already aligned):

| Agent | Path | Env var override |
|-------|------|------------------|
| cursor | `~/.cursor/skills/taskforce/` | `CURSOR_HOME` |
| codex | `~/.codex/skills/taskforce/` | `CODEX_HOME` |
| opencode | `~/.config/opencode/skills/taskforce/` | `OPENCODE_CONFIG_DIR` |
| claude-code | `~/.claude/skills/taskforce/` | `CLAUDE_CONFIG_DIR` (new) |

**Key decisions**:
- `cursor/codex/opencode` share `.agents/skills/taskforce/` in project scope (AGENTS.md standard; one physical copy for multi-agent users). No per-agent subdirectories.
- `claude-code` uses `.claude/skills/` because Claude Code does not follow the `.agents/` convention in project scope.
- Global scope adds `CLAUDE_CONFIG_DIR` for symmetry with `OPENCODE_CONFIG_DIR`/`CODEX_HOME`/`CURSOR_HOME`.

### 2. `install.sh` Changes

Four minimal edits (line numbers refer to current file):

**Edit 1 — usage string (line 12)**:
```diff
-   Usage: ./install.sh --agent cursor|codex|opencode [--scope project|global]
+   Usage: ./install.sh --agent cursor|codex|opencode|claude-code [--scope project|global]
```

**Edit 2 — agent validation (lines 31-34)**:
```diff
- if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" ]]; then
-   echo "--agent must be cursor, codex, or opencode" >&2
+ if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" && "$AGENT" != "claude-code" ]]; then
+   echo "--agent must be cursor, codex, opencode, or claude-code" >&2
    exit 2
  fi
```

**Edit 3 — project scope path (lines 40-45, core change)**:
```diff
  if [[ "$SCOPE" == "project" ]]; then
    case "$AGENT" in
-     cursor) PARENT="$PROJECT_DIR/.cursor/skills" ;;
-     codex) PARENT="$PROJECT_DIR/.codex/skills" ;;
-     opencode) PARENT="$PROJECT_DIR/.opencode/skills" ;;
+     cursor|codex|opencode) PARENT="$PROJECT_DIR/.agents/skills" ;;
+     claude-code) PARENT="$PROJECT_DIR/.claude/skills" ;;
    esac
  else
    case "$AGENT" in
      cursor) PARENT="${CURSOR_HOME:-$HOME/.cursor}/skills" ;;
      codex) PARENT="${CODEX_HOME:-$HOME/.codex}/skills" ;;
      opencode) PARENT="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/skills" ;;
+     claude-code) PARENT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
    esac
  fi
```

**Edit 4 — global scope adds claude-code** (included in Edit 3 above).

**Unchanged**:
- Safety guard `case "$TARGET" in */skills/taskforce)` — new paths still match.
- `--force` logic — still removes only the `taskforce` leaf.
- `mkdir -p` + `cp -R` — still physical copy (installer's role is offline fallback).
- Final echo lines.

### 3. `install.ps1` Changes

Symmetric four edits:
- `[ValidateSet("cursor","codex","opencode")]` → add `"claude-code"`
- Project-scope `switch`: cursor/codex/opencode merge to `Join-Path $Project ".agents"` + `Join-Path ... "skills"`; new claude-code branch → `Join-Path $Project ".claude"`.
- Global-scope `switch`: new claude-code branch using `$env:CLAUDE_CONFIG_DIR` with `$HOME/.claude` fallback.
- Safety guard `(Split-Path -Leaf $Target) -ne "taskforce" -or (Split-Path -Leaf (Split-Path -Parent $Target)) -ne "skills"` unchanged.

### 4. README Restructure

Replace current "Install" section (lines 77-128) with four subsections:

**4.1 Overview paragraph**

> Taskforce follows the open Agent Skills directory format. Three install entry points all place the skill at `<agent>/skills/taskforce/`; they differ only in entry mechanism:
> - **`npx skills add`** (recommended): cross-agent, auto-symlink, supports update/remove.
> - **`install.sh` / `install.ps1`**: pure file copy for offline / air-gapped / audit scenarios.
> - **`.xxx-plugin/plugin.json`**: discovery manifests for each host's native plugin marketplace.

**4.2 Recommended: skills CLI**

```bash
# Simplest (interactive; single-skill repo auto-detected)
npx skills add <GITHUB_OWNER>/taskforce

# CI-friendly (non-interactive, explicit)
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce -y

# Specific agent + global (available across projects)
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent opencode --global
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent claude-code --global
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent cursor --global
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent codex --global
```

> `<GITHUB_OWNER>` is a placeholder; replace once the repository location is finalized.

**4.3 Offline: local installer**

```bash
# macOS/Linux
./install.sh --agent opencode --scope global
./install.sh --agent claude-code --scope project --project /path/to/project
./install.sh --agent cursor --scope global

# PowerShell
.\install.ps1 -Agent opencode -Scope global
.\install.ps1 -Agent claude-code -Scope project -Project C:\path\to\project
```

> The offline installer performs a pure file copy (`cp -R`), no npx dependency. Paths are aligned with `npx skills add` — results from both installers are interchangeable.
>
> Installers refuse to replace an existing `taskforce` directory unless `--force`/`-Force` is supplied. Replacement is limited to the exact `skills/taskforce` destination.
>
> Installation only copies the complete Skill. It does not select a CLI/model, write `.taskforce/roles.json`, alter cmux security settings, or launch agents.

**4.4 Marketplace: plugin manifests**

> Root-level `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/` are discovery manifests for each host's native plugin marketplace. Install via the host's plugin management UI (e.g., Claude Code's `/plugin install`, Cursor's `/add-plugin`). See each host's documentation.

**4.5 Path reference table** (new)

| Agent | project scope | global scope |
|-------|---------------|--------------|
| opencode | `./.agents/skills/taskforce/` | `~/.config/opencode/skills/taskforce/` |
| cursor | `./.agents/skills/taskforce/` | `~/.cursor/skills/taskforce/` |
| codex | `./.agents/skills/taskforce/` | `~/.codex/skills/taskforce/` |
| claude-code | `./.claude/skills/taskforce/` | `~/.claude/skills/taskforce/` |

> In project scope, cursor/codex/opencode share `.agents/skills/` (AGENTS.md standard). claude-code uses `.claude/skills/` per Claude Code's own convention.

**Breaking-change note** (added to 4.3):

> **Breaking**: project-scope installs via `install.sh`/`install.ps1` prior to this change placed skills at `.cursor/skills/`, `.codex/skills/`, or `.opencode/skills/`. Re-run the installer to migrate to `.agents/skills/`; the old directories can be removed manually.

**Unchanged**: "First Use" section and everything after.

### 5. Plugin Manifest Unification

All three manifests (`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`) become **identical**, using the current `.codex-plugin/plugin.json` as the template:

```json
{
  "name": "taskforce",
  "version": "0.1.0",
  "description": "Coordinate terminal-visible coding agents with small tasks, hard evidence, patch scope checks, and acceptance review.",
  "author": {
    "name": "Taskforce contributors"
  },
  "license": "MIT",
  "keywords": ["agents", "coding", "orchestration", "terminal", "review"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Taskforce",
    "shortDescription": "Multi-agent coding orchestration",
    "longDescription": "Taskforce coordinates coding agents through small task files, role routing, hard run evidence, patch scope checks, and acceptance review.",
    "developerName": "Taskforce contributors",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Use Taskforce to split and delegate this coding goal.",
      "Route this feature through Taskforce roles.",
      "Review this Taskforce candidate patch."
    ],
    "brandColor": "#2563EB"
  }
}
```

Rationale: single source of truth, consistent marketplace presentation across hosts, `skills` field enables `npx skills` manifest discovery for all three.

### 6. Test Updates

**File**: `tests/taskforce_installers.test.mjs`

**6.1 Existing test path updates (4 places)**:

- `cursor project install` test (line 58): `.cursor/skills/taskforce` → `.agents/skills/taskforce`
- `existing destination requires --force` test (line 99): same path update
- `powershell cursor project install` test (line 153): same path update
- `installed-copy smoke test` (line 179): `.opencode/skills/taskforce` → `.agents/skills/taskforce`

**6.2 New test: claude-code coverage**

```javascript
test('claude-code installs to .claude/skills (project) and ~/.claude/skills (global)', () => {
  const temp = mkdtemp('tf-inst-claude-');
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  const home = path.join(temp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home };

  // project scope → .claude/skills/taskforce
  const rProj = runShell(['--agent', 'claude-code', '--scope', 'project', '--project', project], env);
  assert.equal(rProj.status, 0, rProj.stderr);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', 'taskforce', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(project, '.agents', 'skills', 'taskforce')));

  // global scope → ~/.claude/skills/taskforce
  const rGlob = runShell(['--agent', 'claude-code', '--scope', 'global'], env);
  assert.equal(rGlob.status, 0, rGlob.stderr);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'taskforce', 'SKILL.md')));
});
```

**6.3 New test: cursor/codex/opencode share .agents/skills**

```javascript
test('cursor/codex/opencode share .agents/skills/taskforce in project scope', () => {
  const temp = mkdtemp('tf-inst-shared-');
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const agent of ['cursor', 'codex', 'opencode']) {
    const r = runShell(['--agent', agent, '--scope', 'project', '--project', project], process.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'taskforce', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(project, `.${agent}`, 'skills', 'taskforce')));
  }
  // Second install to the shared target must be refused without --force
  const refused = runShell(['--agent', 'codex', '--scope', 'project', '--project', project], process.env);
  assert.equal(refused.status, 3);
});
```

**6.4 Documentation contract test update** (lines 130-143):

```diff
  test('documentation and powershell contract', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
-   assert.match(readme, /npx skills add <GITHUB_OWNER>\/taskforce --skill taskforce/);
+   assert.match(readme, /npx skills add <GITHUB_OWNER>\/taskforce/);
+   assert.match(readme, /--skill taskforce -y/);
+   assert.match(readme, /--agent claude-code/);
    assert.match(readme, /--agent cursor --global/);
    assert.match(readme, /--templates skills\/taskforce\/assets\/templates/);
    const powershell = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
-   for (const token of ['ValidateSet("cursor", "codex", "opencode")', '"project", "global"', '[switch]$Force']) {
+   for (const token of ['ValidateSet("cursor", "codex", "opencode", "claude-code")', '"project", "global"', '[switch]$Force']) {
      assert.ok(powershell.includes(token), `powershell missing token: ${token}`);
    }
    assert.match(powershell, /Refusing to overwrite existing Taskforce skill/);
    const shell = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    assert.doesNotMatch(shell, /roles\.json/);
    assert.doesNotMatch(powershell, /roles\.json/);
  });
```

**Untouched tests**: `taskforce_foundation.test.mjs`, `taskforce_onboarding_node.test.mjs`, `taskforce_launch_runner.test.mjs`, `taskforce_orchestrator.test.mjs` (protocol/script behavior, no install-path coupling).

## Verification

After implementation:

```bash
# 1. Shell syntax
bash -n install.sh

# 2. Installer tests
node --test tests/taskforce_installers.test.mjs

# 3. Full suite (per CONTRIBUTING.md)
node --test tests/*.test.mjs
for f in skills/taskforce/scripts/*.mjs; do node --check "$f"; done
bash -n install.sh

# 4. Per-agent manual smoke (optional)
for agent in cursor codex opencode claude-code; do
  tmp=$(mktemp -d)
  ./install.sh --agent $agent --scope project --project $tmp
  test -f "$tmp/.agents/skills/taskforce/SKILL.md" || test -f "$tmp/.claude/skills/taskforce/SKILL.md"
  rm -rf $tmp
done

# 5. Manifest identity
diff .claude-plugin/plugin.json .cursor-plugin/plugin.json  # no diff
diff .claude-plugin/plugin.json .codex-plugin/plugin.json   # no diff
```

## Affected Files

| File | Change |
|------|--------|
| `install.sh` | 4 edits: usage, validation, project-scope path merge, global-scope add claude-code |
| `install.ps1` | 4 symmetric edits |
| `README.md` | Replace "Install" section (lines 77-128) with new 5-subsection structure |
| `.claude-plugin/plugin.json` | Replace stub with full unified template |
| `.cursor-plugin/plugin.json` | Replace stub with full unified template |
| `.codex-plugin/plugin.json` | No content change (already the template); verify identical to others |
| `tests/taskforce_installers.test.mjs` | 4 path updates + 2 new tests + doc-contract assertion updates |

## Breaking Change

Users who installed via `install.sh`/`install.ps1 --scope project` before this change have skills at `.cursor/skills/`, `.codex/skills/`, or `.opencode/skills/`. These old paths are no longer produced. Affected users re-run the installer to get the new `.agents/skills/` location and delete the old directory manually. Documented in README §4.3.

No backward-compatibility shim. This is an explicit one-time fix per the approved direction.
