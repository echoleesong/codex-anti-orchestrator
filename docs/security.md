# Security Model and Operational Constraints

This document defines the security boundaries, operational constraints, and safety guarantees enforced by `codex-anti-orchestrator`.

---

## 1. Core Principles

1. **Defense in Depth**: Every automated component operates under the principle of least privilege.
2. **Strict Human Gatekeeping**: Automated agents may produce, test, and review code, but only human operators may approve merges or trigger deployments.
3. **External Workspace & State Isolation**: Tasks, runtime state (`state.json`), and temporary Git worktrees must be located strictly outside the target repository to avoid polluting the host workspace.
4. **Strict Repository Boundaries**: Production daemon strictly enforces that target repositories reside exclusively under `/Users/lisong/code`.
5. **Zero Secret Persistence**: Authentication credentials, personal access tokens, and sensitive machine configurations must never be persisted in repository files or build artifacts.

---

## 2. Security Boundaries & Constraints

### 2.1 External Worktree & State Directory Isolation

- **Orchestrator State Directory**: All runtime task execution, metadata, and temporary Git worktrees reside strictly outside the target repository under the orchestrator state directory (e.g. `~/.codex-anti-orchestrator/worktrees/<task-id>` or `$XDG_STATE_HOME/codex-anti-orchestrator/worktrees/<task-id>`).
- **State Path Validation**: The state directory path is validated via canonical `realpath` and parent hierarchy checks. State directories located inside the target repository or pointing to it via symlink escapes are strictly rejected.
- **Zero In-Repo Pollution**: The target repository directory remains clean, with no temporary subdirectories, untracked generated files, or local Git lock contention.
- **State Preservation**: When a task enters `AWAITING_HUMAN_APPROVAL`, `NEEDS_USER_DECISION`, `AWAITING_HUMAN_OVERRIDE`, or `FAILED`, the worktree is preserved in the state directory for inspection and debugging before explicit cleanup on `COMPLETED` or `ABORTED`.

### 2.2 Production Target Path Confinement

- **Allowed Base Directory**: The CLI strictly enforces that target repositories must reside within `/Users/lisong/code` project subdirectories.
- **Traversal Protection**: Relative paths with `..`, root path attempts, and symlinks resolving outside `/Users/lisong/code` are halted with permission denial errors.

### 2.3 Git Lockfile Safety

- **Strict Read-Only Inspection**: When creating tasks, the orchestrator inspects the target repository for lock files (`.git/index.lock`, etc.).
- **No Automatic Lock Deletion**: If a lock file exists or if lock inspection fails, task creation is immediately aborted to prevent race conditions. The orchestrator never automatically deletes lock files.

### 2.4 Minimal GitHub CLI (`gh`) Permissions

- **Scope Limitation**: GitHub authentication must be limited strictly to standard developer repository scopes (`repo`, `read:org`, `workflow`).
- **No Privilege Escalation**: The orchestrator must not request admin privileges, organization management scopes, or user key modifications.
- **Read-Only Diagnostics**: Diagnostic commands (`doctor`) strictly read local or API status without creating repositories, tokens, or SSH keys.

### 2.5 Strict Prohibition of Auto-Merge & Auto-Deploy

- **No Auto-Merge**: The daemon and review agents are strictly prohibited from executing `gh pr merge`, fast-forwarding `main`, or bypassing branch protection rules.
- **Strict Separation of Approval States**:
  - `AWAITING_HUMAN_APPROVAL`: Strictly reserved for 100% clean passes (all automated tests green + zero Codex review blocking issues).
  - `AWAITING_HUMAN_OVERRIDE`: Explicitly flags unresolved risks or warnings when user manually overrides iteration limits. Never treated as clean or auto-mergeable.
- **No Auto-Deploy**: The pipeline stops at human review states (`AWAITING_HUMAN_APPROVAL` or `AWAITING_HUMAN_OVERRIDE`). Deployment workflows must be triggered exclusively through established, human-approved CI/CD gates.
- **Protected Branch Shield**: Pushes to `main`, `master`, `release`, `production`, `prod`, and `develop` are rejected at the adapter boundary before any Git network command is issued.

### 2.6 Safe Child Process Abstraction & Argument Arrays

- **No Shell Execution**: All external commands (`git`, `gh`, `agy`, `codex`) are invoked strictly through explicit argument arrays (`execFile` with `shell: false`). Command strings are never concatenated into shell execution pipelines.
- **Pre-execution Flag Rejection**: The executor intercepts arguments before process spawn. Any argument matching forbidden flags (including `--dangerously-skip-permissions` and `--dangerously-skip-permissions=...`) causes immediate execution abort with a security violation error.
- **Resource and Timeout Bounding**: Processes run with strict timeout limits (default 60s, configurable) and bounded stdout/stderr buffers (10MB default) to prevent runaway memory usage or hangs.

### 2.7 Automated Secret & Token Redaction

- **Zero Secret Persistence**: No API keys, GitHub PATs, OpenAI tokens, or session IDs may be hardcoded or written to tracked files.
- **Environment & Keyring Resolution**: Authentication relies on system keyrings (`gh auth`) or environment variables loaded dynamically at runtime.
- **Stream Scrubbing**: All process outputs (`stdout`, `stderr`, error messages) pass through automated regex redaction scrubbing:
  - GitHub PATs / OAuth tokens (`ghp_*`, `github_pat_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`) -> `[REDACTED_GITHUB_TOKEN]`
  - OpenAI API keys (`sk-*`, `sk-proj-*`) -> `[REDACTED_OPENAI_KEY]`
  - Anthropic API keys (`sk-ant-*`) -> `[REDACTED_ANTHROPIC_KEY]`
  - Bearer authorization headers -> `Bearer [REDACTED_BEARER_TOKEN]`
  - Basic auth in URLs (`https://user:pass@host`) -> `https://user:[REDACTED_PASSWORD]@host`
  - Key-value secret assignments in configuration and logs.

### 2.8 Codex CLI Read-Only Review & Fail-Safe Parsing

- **Review-Only Mode**: During the review phase, OpenAI Codex CLI (`codex`) is invoked strictly with read-only flags (`codex exec --sandbox read-only`).
- **No Code Mutation**: Codex must inspect git diffs, ASTs, and PR metadata to produce structured comments and suggestions, but is strictly disallowed from writing files or making commits directly.
- **Fail-Safe Verdict Parsing**:
  - Valid verdicts: `APPROVE`, `CHANGES_REQUIRED`, `NEEDS_USER_DECISION`.
  - An `APPROVE` verdict with residual blocking issues is automatically downgraded to `CHANGES_REQUIRED`.
  - Empty, malformed, non-JSON, or unparseable review outputs fail safe directly to `NEEDS_USER_DECISION`, halting automated loops and preventing unauthorized progression.

### 2.9 Safe Antigravity CLI (`agy`) Execution & Statelessness

- **Noninteractive Mode & Permissions Boundary**: `agy` is invoked noninteractively using `--mode accept-edits` and `--print` within the isolated external worktree with `--sandbox` restrictions enabled.
- **Explicit Options Validation**: Only validated explicit `--model` identifiers and bounded `--print-timeout` durations (between 1s and 30m) are supported; arbitrary CLI flags are prohibited.
- **Forbidden Flags**: Invoking `agy` with `--dangerously-skip-permissions` is strictly prohibited under all circumstances.
- **Sandbox Compliance**: Agent operations are explicitly invoked with `--sandbox` and confined to the isolated external worktree.
- **Stateless Invocation**: `agy` tasks are self-contained per iteration with explicit prompt context. No false promises of internal daemon session resumption are made.

### 2.10 GitHub PR Adapter Boundaries

- **Allowed Actions**: Limited strictly to PR metadata operations: `create`, `view`, `update`, and `checks`.
- **Forbidden Actions**: Any operation containing `merge`, `workflow`, `release`, `deploy`, `dispatch`, or `publish` is rejected by assertion.
- **Task Branch Restriction**: Pushes are strictly restricted to `anti/*` branches.

---

## 3. Threat Model & Mitigations

| Threat                                            | Impact                                      | Mitigation Enforced                                                                                                                   |
| :------------------------------------------------ | :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent hallucinating destructive shell command** | Loss of local files or workspace corruption | Argument arrays only (`shell: false`) + external worktree isolation + prohibition of bypass flags (`--dangerously-skip-permissions`). |
| **Target repository path traversal**              | Unauthorized repository modification        | Strict confinement to `/Users/lisong/code` + realpath canonical validation.                                                           |
| **Git lock race condition / corruption**          | Corrupted git index or repository loss      | Fast-fail lock detection with explicit prohibition of automatic lockfile deletion.                                                    |
| **Accidental secret leak in stdout / logs**       | Exposed API tokens or GitHub credentials    | Strict `.gitignore`, automated multi-pattern secret scrubbing in process streams, and no token persistence in codebase.               |
| **Unintended code merge to production**           | Defective code shipped to users             | Hard block on automatic merge commands; mandatory human PR approval gate; protected branch push shield.                               |
| **Review tool mutating code during analysis**     | Unaudited and unverified modifications      | Codex CLI runs strictly in read-only inspection mode.                                                                                 |
| **Malformed review output causing false bypass**  | Bugs merged without proper verification     | Fail-safe verdict parser defaults unparseable/empty output to `NEEDS_USER_DECISION`.                                                  |
| **Cross-repository or in-repo pollution**         | Residual files or corrupted workspace       | Worktrees strictly located in dedicated external orchestrator state directory with path isolation validation.                         |
