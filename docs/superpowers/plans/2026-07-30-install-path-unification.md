# Install Path Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Taskforce's three installation entry points so `install.sh`/`install.ps1` produce identical paths to `npx skills add`, add `claude-code` agent support, make all three plugin manifests consistent, and restructure the README accordingly.

**Architecture:** Minimal-diff changes to two shell installers (path table + claude-code branch), three identical JSON manifests, one README restructure, and test updates (4 path fixes + 2 new tests). No new files, no new abstractions. Breaking change — no backward-compat shims.

**Tech Stack:** Bash, PowerShell, JSON, Markdown, Node.js test runner (`node --test`).

**Spec:** `specs/2026-07-30-install-path-unification-design.md`

---

## File Structure

| File | Responsibility | Change Type |
|------|----------------|-------------|
| `install.sh` | Offline installer (macOS/Linux) | Modify: 4 edits |
| `install.ps1` | Offline installer (Windows) | Modify: 4 symmetric edits |
| `.claude-plugin/plugin.json` | Claude Code marketplace manifest | Replace stub with full template |
| `.cursor-plugin/plugin.json` | Cursor marketplace manifest | Replace stub with full template |
| `.codex-plugin/plugin.json` | Codex marketplace manifest | Verify identical (no content change expected) |
| `README.md` | Install documentation | Replace "Install" section (lines 77-128) |
| `tests/taskforce_installers.test.mjs` | Installer test coverage | Modify: 4 path updates + 2 new tests + doc-contract update |

---

## Task 1: Update `install.sh` — usage string and agent validation

**Files:**
- Modify: `install.sh:10-18` (usage function)
- Modify: `install.sh:31-34` (agent validation)

- [ ] **Step 1: Update usage string (line 12)**

Edit `install.sh` line 12. Old:
```
  Usage: ./install.sh --agent cursor|codex|opencode [--scope project|global]
```
New:
```
  Usage: ./install.sh --agent cursor|codex|opencode|claude-code [--scope project|global]
```

- [ ] **Step 2: Update agent validation (lines 31-34)**

Old:
```bash
if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" ]]; then
  echo "--agent must be cursor, codex, or opencode" >&2
  exit 2
fi
```
New:
```bash
if [[ "$AGENT" != "cursor" && "$AGENT" != "codex" && "$AGENT" != "opencode" && "$AGENT" != "claude-code" ]]; then
  echo "--agent must be cursor, codex, opencode, or claude-code" >&2
  exit 2
fi
```

- [ ] **Step 3: Verify shell syntax**

Run: `bash -n install.sh`
Expected: no output, exit 0

- [ ] **Step 4: Verify claude-code is now accepted, invalid agent still rejected**

Run:
```bash
./install.sh --agent claude-code --scope global --project /tmp/nonexistent-test 2>&1 | head -5
```
Expected: output mentions "Installed the complete Taskforce skill to" (it proceeds past validation; will then try to install to `~/.claude/skills/taskforce/` — see Task 2 for the path). If you don't want a real install, interrupt or run in an isolated HOME.

Also verify rejection still works:
```bash
./install.sh --agent invalidagent --scope global 2>&1
```
Expected: `--agent must be cursor, codex, opencode, or claude-code`, exit code 2.

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat(install): accept claude-code agent in install.sh validation"
```

---

## Task 2: Update `install.sh` — project and global scope paths

**Files:**
- Modify: `install.sh:40-52` (scope path case blocks)

- [ ] **Step 1: Replace project-scope and global-scope case blocks (lines 40-52)**

Old:
```bash
if [[ "$SCOPE" == "project" ]]; then
  case "$AGENT" in
    cursor) PARENT="$PROJECT_DIR/.cursor/skills" ;;
    codex) PARENT="$PROJECT_DIR/.codex/skills" ;;
    opencode) PARENT="$PROJECT_DIR/.opencode/skills" ;;
  esac
else
  case "$AGENT" in
    cursor) PARENT="${CURSOR_HOME:-$HOME/.cursor}/skills" ;;
    codex) PARENT="${CODEX_HOME:-$HOME/.codex}/skills" ;;
    opencode) PARENT="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/skills" ;;
  esac
fi
```
New:
```bash
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
```

- [ ] **Step 2: Verify shell syntax**

Run: `bash -n install.sh`
Expected: no output, exit 0

- [ ] **Step 3: Smoke test all four agents in project scope (isolated temp dir)**

Run:
```bash
tmp=$(mktemp -d)
for agent in cursor codex opencode claude-code; do
  proj=$(mktemp -d)
  ./install.sh --agent $agent --scope project --project $proj >/dev/null 2>&1
  if [ "$agent" = "claude-code" ]; then
    test -f "$proj/.claude/skills/taskforce/SKILL.md" && echo "$agent: OK (.claude)" || echo "$agent: FAIL"
  else
    test -f "$proj/.agents/skills/taskforce/SKILL.md" && echo "$agent: OK (.agents)" || echo "$agent: FAIL"
  fi
  rm -rf $proj
done
rm -rf $tmp
```
Expected:
```
cursor: OK (.agents)
codex: OK (.agents)
opencode: OK (.agents)
claude-code: OK (.claude)
```

- [ ] **Step 4: Smoke test claude-code global scope in isolated HOME**

Run:
```bash
tmp=$(mktemp -d)
HOME=$tmp ./install.sh --agent claude-code --scope global >/dev/null 2>&1
test -f "$tmp/.claude/skills/taskforce/SKILL.md" && echo "claude-code global: OK" || echo "claude-code global: FAIL"
rm -rf $tmp
```
Expected: `claude-code global: OK`

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat(install): unify project scope to .agents/skills, add claude-code paths"
```

---

## Task 3: Update `install.ps1` — symmetric changes

**Files:**
- Modify: `install.ps1:4` (ValidateSet)
- Modify: `install.ps1:19-42` (scope path switch blocks)

- [ ] **Step 1: Update ValidateSet (line 4)**

Old:
```powershell
  [ValidateSet("cursor", "codex", "opencode")]
```
New:
```powershell
  [ValidateSet("cursor", "codex", "opencode", "claude-code")]
```

- [ ] **Step 2: Update project-scope switch block (lines 19-26)**

Old:
```powershell
if ($Scope -eq "project") {
  $base = switch ($Agent) {
    "cursor" { Join-Path $Project ".cursor" }
    "codex" { Join-Path $Project ".codex" }
    "opencode" { Join-Path $Project ".opencode" }
  }
  $Parent = Join-Path $base "skills"
}
```
New:
```powershell
if ($Scope -eq "project") {
  $base = switch ($Agent) {
    "cursor" { Join-Path $Project ".agents" }
    "codex" { Join-Path $Project ".agents" }
    "opencode" { Join-Path $Project ".agents" }
    "claude-code" { Join-Path $Project ".claude" }
  }
  $Parent = Join-Path $base "skills"
}
```

- [ ] **Step 3: Update global-scope switch block (lines 28-42)**

Old:
```powershell
else {
  $Parent = switch ($Agent) {
    "cursor" {
      $homePath = if ($env:CURSOR_HOME) { $env:CURSOR_HOME } else { Join-Path $HOME ".cursor" }
      Join-Path $homePath "skills"
    }
    "codex" {
      $homePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
      Join-Path $homePath "skills"
    }
    "opencode" {
      $homePath = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path (Join-Path $HOME ".config") "opencode" }
      Join-Path $homePath "skills"
    }
  }
}
```
New (append claude-code branch):
```powershell
else {
  $Parent = switch ($Agent) {
    "cursor" {
      $homePath = if ($env:CURSOR_HOME) { $env:CURSOR_HOME } else { Join-Path $HOME ".cursor" }
      Join-Path $homePath "skills"
    }
    "codex" {
      $homePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
      Join-Path $homePath "skills"
    }
    "opencode" {
      $homePath = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path (Join-Path $HOME ".config") "opencode" }
      Join-Path $homePath "skills"
    }
    "claude-code" {
      $homePath = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
      Join-Path $homePath "skills"
    }
  }
}
```

- [ ] **Step 4: Verify syntax (if pwsh available)**

Run:
```bash
which pwsh >/dev/null 2>&1 && pwsh -NoProfile -Command "Get-Content install.ps1 | Out-Null" && echo "pwsh syntax OK" || echo "pwsh not available, skip syntax check (file is text-only edit)"
```
Expected: either "pwsh syntax OK" or "pwsh not available, skip..." (both acceptable; the test in Task 7 will exercise it if pwsh exists).

- [ ] **Step 5: Commit**

```bash
git add install.ps1
git commit -m "feat(install): mirror install.sh path unification in install.ps1"
```

---

## Task 4: Unify `.claude-plugin/plugin.json`

**Files:**
- Replace contents: `.claude-plugin/plugin.json`

- [ ] **Step 1: Replace the file with the unified template**

New content:
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

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log('valid JSON')"`
Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(manifest): unify .claude-plugin/plugin.json with full template"
```

---

## Task 5: Unify `.cursor-plugin/plugin.json`

**Files:**
- Replace contents: `.cursor-plugin/plugin.json`

- [ ] **Step 1: Replace the file with the unified template**

New content (identical to Task 4):
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

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.cursor-plugin/plugin.json','utf8')); console.log('valid JSON')"`
Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add .cursor-plugin/plugin.json
git commit -m "feat(manifest): unify .cursor-plugin/plugin.json with full template"
```

---

## Task 6: Verify `.codex-plugin/plugin.json` matches

**Files:**
- Verify only: `.codex-plugin/plugin.json`

- [ ] **Step 1: Verify .codex-plugin already matches the template**

Run:
```bash
diff .claude-plugin/plugin.json .codex-plugin/plugin.json
echo "exit: $?"
```
Expected: no diff output, exit 0 (the codex manifest was the template source).

- [ ] **Step 2: Verify all three are identical**

Run:
```bash
diff .claude-plugin/plugin.json .cursor-plugin/plugin.json && \
diff .claude-plugin/plugin.json .codex-plugin/plugin.json && \
echo "all three manifests identical"
```
Expected: `all three manifests identical`

- [ ] **Step 3: No commit needed (no changes)**

If diff shows no changes to `.codex-plugin/plugin.json`, skip commit. If it differs (unexpected), replace `.codex-plugin/plugin.json` with the same template and commit.

---

## Task 7: Update test file — existing test path fixes

**Files:**
- Modify: `tests/taskforce_installers.test.mjs:58` (cursor project target)
- Modify: `tests/taskforce_installers.test.mjs:99` (force test marker)
- Modify: `tests/taskforce_installers.test.mjs:153` (powershell target)
- Modify: `tests/taskforce_installers.test.mjs:179` (smoke test skill path)

- [ ] **Step 1: Update cursor project install test path (line 58)**

Old:
```javascript
  const target = path.join(project, '.cursor', 'skills', 'taskforce');
```
New:
```javascript
  const target = path.join(project, '.agents', 'skills', 'taskforce');
```

- [ ] **Step 2: Update force test marker path (line 99)**

Old:
```javascript
  const marker = path.join(project, '.cursor', 'skills', 'taskforce', 'local-marker');
```
New:
```javascript
  const marker = path.join(project, '.agents', 'skills', 'taskforce', 'local-marker');
```

- [ ] **Step 3: Update powershell test target path (line 153)**

Old:
```javascript
  assert.ok(fs.existsSync(path.join(project, '.cursor', 'skills', 'taskforce', 'SKILL.md')));
```
New:
```javascript
  assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'taskforce', 'SKILL.md')));
```

- [ ] **Step 4: Update smoke test skill path (line 179)**

Old:
```javascript
  const skill = path.join(project, '.opencode', 'skills', 'taskforce');
```
New:
```javascript
  const skill = path.join(project, '.agents', 'skills', 'taskforce');
```

- [ ] **Step 5: Run installer tests — expect path-related tests to pass now, but new claude-code tests not yet added**

Run: `node --test tests/taskforce_installers.test.mjs`
Expected: all existing tests PASS (the 4 path updates align with the installer changes from Tasks 1-2). The claude-code and shared-target tests don't exist yet (added in Task 8).

- [ ] **Step 6: Commit**

```bash
git add tests/taskforce_installers.test.mjs
git commit -m "test(install): update existing tests for unified .agents/skills path"
```

---

## Task 8: Add new test — claude-code coverage

**Files:**
- Modify: `tests/taskforce_installers.test.mjs` (add new test block)

- [ ] **Step 1: Add the claude-code test after the global targets test (after line 128)**

Insert this new test after the `global targets are destination-scoped` test (which ends at line 128):

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
  // claude-code must NOT use the shared .agents path
  assert.ok(!fs.existsSync(path.join(project, '.agents', 'skills', 'taskforce')));

  // global scope → ~/.claude/skills/taskforce
  const rGlob = runShell(['--agent', 'claude-code', '--scope', 'global'], env);
  assert.equal(rGlob.status, 0, rGlob.stderr);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'taskforce', 'SKILL.md')));
});
```

- [ ] **Step 2: Run the new test in isolation**

Run: `node --test --test-name-pattern="claude-code installs" tests/taskforce_installers.test.mjs`
Expected: PASS (1 test, 0 fail)

- [ ] **Step 3: Commit**

```bash
git add tests/taskforce_installers.test.mjs
git commit -m "test(install): add claude-code project and global scope coverage"
```

---

## Task 9: Add new test — cursor/codex/opencode share `.agents/skills`

**Files:**
- Modify: `tests/taskforce_installers.test.mjs` (add new test block)

- [ ] **Step 1: Add the shared-target test after the claude-code test**

Insert this new test immediately after the one added in Task 8:

```javascript
test('cursor/codex/opencode share .agents/skills/taskforce in project scope', () => {
  const temp = mkdtemp('tf-inst-shared-');
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const agent of ['cursor', 'codex', 'opencode']) {
    const r = runShell(['--agent', agent, '--scope', 'project', '--project', project], process.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'taskforce', 'SKILL.md')));
    // must NOT create per-agent legacy directories
    assert.ok(!fs.existsSync(path.join(project, `.${agent}`, 'skills', 'taskforce')));
  }
  // Second install to the shared target must be refused without --force
  const refused = runShell(['--agent', 'codex', '--scope', 'project', '--project', project], process.env);
  assert.equal(refused.status, 3);
});
```

- [ ] **Step 2: Run the new test in isolation**

Run: `node --test --test-name-pattern="cursor/codex/opencode share" tests/taskforce_installers.test.mjs`
Expected: PASS (1 test, 0 fail)

- [ ] **Step 3: Commit**

```bash
git add tests/taskforce_installers.test.mjs
git commit -m "test(install): verify cursor/codex/opencode share .agents/skills"
```

---

## Task 10: Update documentation contract test

**Files:**
- Modify: `tests/taskforce_installers.test.mjs:130-143` (documentation and powershell contract test)

- [ ] **Step 1: Update README assertions (lines 131-134)**

Old:
```javascript
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npx skills add <GITHUB_OWNER>\/taskforce --skill taskforce/);
  assert.match(readme, /--agent cursor --global/);
  assert.match(readme, /--templates skills\/taskforce\/assets\/templates/);
```
New:
```javascript
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npx skills add <GITHUB_OWNER>\/taskforce/);
  assert.match(readme, /--skill taskforce -y/);
  assert.match(readme, /--agent claude-code/);
  assert.match(readme, /--agent cursor --global/);
  assert.match(readme, /--templates skills\/taskforce\/assets\/templates/);
```

- [ ] **Step 2: Update PowerShell ValidateSet assertion (line 136)**

Old:
```javascript
  for (const token of ['ValidateSet("cursor", "codex", "opencode")', '"project", "global"', '[switch]$Force']) {
```
New:
```javascript
  for (const token of ['ValidateSet("cursor", "codex", "opencode", "claude-code")', '"project", "global"', '[switch]$Force']) {
```

- [ ] **Step 3: Run the contract test in isolation (expect FAIL — README not yet updated)**

Run: `node --test --test-name-pattern="documentation and powershell contract" tests/taskforce_installers.test.mjs`
Expected: FAIL (README still has old content — this is the red phase; Task 11 makes it green).

- [ ] **Step 4: Commit (red test is intentional, will pass after Task 11)**

```bash
git add tests/taskforce_installers.test.mjs
git commit -m "test(install): update doc contract for new README structure and claude-code"
```

---

## Task 11: Restructure README "Install" section

**Files:**
- Modify: `README.md:77-128` (replace entire Install section)

- [ ] **Step 1: Replace the Install section (lines 77-128)**

Old (lines 77-128, the entire current Install section from `## Install` through the end of the "Installation only copies..." paragraph):

```
## Install

Taskforce follows the open Agent Skills directory format. The primary
installation path is the `skills` CLI:

```bash
# Replace <GITHUB_OWNER> with the repository owner after publication.
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce
```

Examples for specific hosts:

```bash
# Cursor, current project
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent cursor

# Cursor, all projects
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent cursor --global

# Codex or OpenCode, global
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent codex --global
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent opencode --global
```

`<GITHUB_OWNER>` is intentionally a placeholder; do not paste it literally
after the final repository location is known.

### Local fallback installer

After cloning and inspecting this repository, macOS/Linux users can run:

```bash
./install.sh --agent cursor --scope project --project /path/to/project
./install.sh --agent codex --scope global
./install.sh --agent opencode --scope global
```

PowerShell equivalents:

```powershell
.\install.ps1 -Agent cursor -Scope project -Project C:\path\to\project
.\install.ps1 -Agent codex -Scope global
.\install.ps1 -Agent opencode -Scope global
```

Installers refuse to replace an existing `taskforce` directory unless
`--force`/`-Force` is explicitly supplied. Replacement is limited to the exact
`skills/taskforce` destination.

Installation only copies the complete Skill. It does not select a CLI/model,
write `.taskforce/roles.json`, alter cmux security settings, or launch agents.
```

New (the complete replacement):

````markdown
## Install

Taskforce follows the open Agent Skills directory format. Three install entry points all place the skill at `<agent>/skills/taskforce/`; they differ only in entry mechanism:

- **`npx skills add`** (recommended): cross-agent, auto-symlink, supports update/remove.
- **`install.sh` / `install.ps1`**: pure file copy for offline / air-gapped / audit scenarios.
- **`.xxx-plugin/plugin.json`**: discovery manifests for each host's native plugin marketplace.

### Recommended: skills CLI

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

`<GITHUB_OWNER>` is intentionally a placeholder; do not paste it literally after the final repository location is known.

### Offline: local installer

```bash
# macOS/Linux
./install.sh --agent opencode --scope global
./install.sh --agent claude-code --scope project --project /path/to/project
./install.sh --agent cursor --scope global
```

PowerShell equivalents:

```powershell
.\install.ps1 -Agent opencode -Scope global
.\install.ps1 -Agent claude-code -Scope project -Project C:\path\to\project
.\install.ps1 -Agent cursor -Scope global
```

The offline installer performs a pure file copy (`cp -R`), no npx dependency. Paths are aligned with `npx skills add` — results from both installers are interchangeable.

Installers refuse to replace an existing `taskforce` directory unless `--force`/`-Force` is explicitly supplied. Replacement is limited to the exact `skills/taskforce` destination.

Installation only copies the complete Skill. It does not select a CLI/model, write `.taskforce/roles.json`, alter cmux security settings, or launch agents.

> **Breaking**: project-scope installs via `install.sh`/`install.ps1` prior to this change placed skills at `.cursor/skills/`, `.codex/skills/`, or `.opencode/skills/`. Re-run the installer to migrate to `.agents/skills/`; the old directories can be removed manually.

### Marketplace: plugin manifests

Root-level `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/` are discovery manifests for each host's native plugin marketplace. Install via the host's plugin management UI (e.g., Claude Code's `/plugin install`, Cursor's `/add-plugin`). See each host's documentation.

### Install paths reference

| Agent | project scope | global scope |
|-------|---------------|--------------|
| opencode | `./.agents/skills/taskforce/` | `~/.config/opencode/skills/taskforce/` |
| cursor | `./.agents/skills/taskforce/` | `~/.cursor/skills/taskforce/` |
| codex | `./.agents/skills/taskforce/` | `~/.codex/skills/taskforce/` |
| claude-code | `./.claude/skills/taskforce/` | `~/.claude/skills/taskforce/` |

In project scope, cursor/codex/opencode share `.agents/skills/` (AGENTS.md standard). claude-code uses `.claude/skills/` per Claude Code's own convention.
````

- [ ] **Step 2: Verify the documentation contract test now passes**

Run: `node --test --test-name-pattern="documentation and powershell contract" tests/taskforce_installers.test.mjs`
Expected: PASS (all README assertions and PowerShell token assertions satisfied).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(install): restructure Install section with path table and claude-code"
```

---

## Task 12: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run shell syntax check**

Run: `bash -n install.sh`
Expected: no output, exit 0

- [ ] **Step 2: Run the full installer test suite**

Run: `node --test tests/taskforce_installers.test.mjs`
Expected: all tests PASS (existing 4 path-updated tests + 2 new tests + updated doc contract test; powershell test may skip if pwsh unavailable).

- [ ] **Step 3: Run the full project test suite (per CONTRIBUTING.md)**

Run:
```bash
node --test tests/*.test.mjs
for f in skills/taskforce/scripts/*.mjs; do node --check "$f"; done
bash -n install.sh
```
Expected: all tests PASS, no script syntax errors.

- [ ] **Step 4: Verify all three manifests are identical**

Run:
```bash
diff .claude-plugin/plugin.json .cursor-plugin/plugin.json && \
diff .claude-plugin/plugin.json .codex-plugin/plugin.json && \
echo "all three manifests identical"
```
Expected: `all three manifests identical`

- [ ] **Step 5: Final per-agent smoke test**

Run:
```bash
for agent in cursor codex opencode claude-code; do
  tmp=$(mktemp -d)
  ./install.sh --agent $agent --scope project --project $tmp >/dev/null 2>&1
  if [ "$agent" = "claude-code" ]; then
    test -f "$tmp/.claude/skills/taskforce/SKILL.md" && echo "$agent: OK" || echo "$agent: FAIL"
  else
    test -f "$tmp/.agents/skills/taskforce/SKILL.md" && echo "$agent: OK" || echo "$agent: FAIL"
  fi
  rm -rf $tmp
done
```
Expected:
```
cursor: OK
codex: OK
opencode: OK
claude-code: OK
```

- [ ] **Step 6: No commit (verification only)**

If all steps pass, the implementation is complete. If any step fails, debug and fix before proceeding.

---

## Self-Review Notes

**Spec coverage check:**
- §1 Unified path table → Tasks 2, 3 (installer paths) + Task 11 (README table)
- §2 install.sh changes → Tasks 1, 2
- §3 install.ps1 changes → Task 3
- §4 README restructure → Task 11
- §5 Plugin manifest unification → Tasks 4, 5, 6
- §6 Test updates (6.1-6.4) → Tasks 7, 8, 9, 10
- Verification → Task 12

All spec sections have corresponding tasks. ✅

**Placeholder scan:** No TBD/TODO/vague language. All steps contain exact code or commands. ✅

**Type/name consistency:** `claude-code` used consistently across install.sh, install.ps1, manifests, tests, README. `CLAUDE_CONFIG_DIR` env var name consistent across install.sh and install.ps1. `.agents/skills/` path consistent across all tasks. ✅
