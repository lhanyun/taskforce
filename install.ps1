[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("cursor", "codex", "opencode", "claude-code", "workbuddy")]
  [string]$Agent,

  [ValidateSet("project", "global")]
  [string]$Scope = "global",

  [string]$Project = (Get-Location).Path,

  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root "skills\taskforce"

if ($Scope -eq "project") {
  $base = switch ($Agent) {
    "cursor" { Join-Path $Project ".agents" }
    "codex" { Join-Path $Project ".agents" }
    "opencode" { Join-Path $Project ".agents" }
    "claude-code" { Join-Path $Project ".claude" }
    "workbuddy" { Join-Path $Project ".workbuddy" }
  }
  $Parent = Join-Path $base "skills"
}
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
    "workbuddy" {
      $homePath = if ($env:WORKBUDDY_HOME) { $env:WORKBUDDY_HOME } else { Join-Path $HOME ".workbuddy" }
      Join-Path $homePath "skills"
    }
  }
}

$Target = Join-Path $Parent "taskforce"
if ((Split-Path -Leaf $Target) -ne "taskforce" -or (Split-Path -Leaf (Split-Path -Parent $Target)) -ne "skills") {
  throw "Refusing unsafe destination: $Target"
}

if (Test-Path -LiteralPath $Target) {
  if (-not $Force) {
    throw "Refusing to overwrite existing Taskforce skill: $Target. Re-run with -Force to replace this exact destination."
  }
  # Preserve host-managed metadata (e.g. workbuddy's _user_meta.json) across replacement.
  $PreservedMeta = $null
  $MetaPath = Join-Path $Target "_user_meta.json"
  if (Test-Path -LiteralPath $MetaPath -PathType Leaf) {
    $PreservedMeta = [System.IO.Path]::GetTempFileName()
    Copy-Item -LiteralPath $MetaPath -Destination $PreservedMeta
  }
  Remove-Item -LiteralPath $Target -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $Parent | Out-Null
Copy-Item -LiteralPath $Source -Destination $Target -Recurse

if ($PreservedMeta) {
  Copy-Item -LiteralPath $PreservedMeta -Destination (Join-Path $Target "_user_meta.json")
  Remove-Item -LiteralPath $PreservedMeta -Force
}

Write-Host "Installed the complete Taskforce skill to $Target"
Write-Host "Next: reload your agent host and invoke Taskforce in a project."
Write-Host "First use will run doctor, role CLI/model confirmation, cmux checks, and preflight."
