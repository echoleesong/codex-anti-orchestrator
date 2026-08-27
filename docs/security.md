# Security Model and Operational Constraints

This document defines the security boundaries, operational constraints, and safety guarantees enforced by `codex-anti-orchestrator`.

---

## 1. Core Principles

1. **Defense in Depth**: Every automated component operates under the principle of least privilege.
2. **Strict Human Gatekeeping**: Automated agents may produce, test, and review code, but only human operators may approve merges or trigger deployments.
3. **Workspace Isolation**: No development task runs directly inside the primary repository directory.
4. **Zero Secret Persistence**: Authentication credentials, personal access tokens, and sensitive machine configurations must never be persisted in repository files or build artifacts.

---

## 2. Security Boundaries & Constraints

### 2.1 Git Worktree Isolation

- **Ephemeral Worktrees**: Every task handled by `agy` runs in a dedicated, isolated Git worktree (e.g. `.worktrees/task-<id>`).
- **Pollution Prevention**: The main working directory and active user branches remain untouched during background agent execution.
- **Cleanup Guarantee**: On task completion or abort, temporary worktrees are pruned cleanly without leaving untracked residue.

### 2.2 Minimal GitHub CLI (`gh`) Permissions

- **Scope Limitation**: GitHub authentication must be limited strictly to standard developer repository scopes (`repo`, `read:org`, `workflow`).
- **No Privilege Escalation**: The orchestrator must not request admin privileges, organization management scopes, or user key modifications.
- **Read-Only Status Inspection**: Diagnostic commands (`doctor`) strictly read local or API status without creating repositories, tokens, or SSH keys.

### 2.3 Strict Prohibition of Auto-Merge & Auto-Deploy

- **No Auto-Merge**: The daemon and review agents are strictly prohibited from executing `gh pr merge`, fast-forwarding `main`, or bypassing branch protection rules.
- **No Auto-Deploy**: The pipeline stops at the "Awaiting Human Approval" state. Deployment workflows must be triggered exclusively through established, human-approved CI/CD gates.

### 2.4 Token and Credential Safety

- **No Embedded Credentials**: No API keys, GitHub PATs, OpenAI tokens, or session IDs may be hardcoded or written to tracked files.
- **Environment & Keyring Resolution**: Authentication must rely on system keyrings (`gh auth`) or standard environment variables loaded at runtime.
- **Log Sanitization**: Orchestrator logs must filter out authorization headers, bearer tokens, and sensitive query strings before logging to stdout or disk.

### 2.5 Codex CLI Read-Only Review Constraint

- **Review-Only Mode**: During the review phase, OpenAI Codex CLI (`codex`) is invoked strictly in read-only analysis mode.
- **No Code Mutation**: Codex must inspect git diffs, ASTs, and PR metadata to produce structured comments and suggestions, but is strictly disallowed from writing files or making commits directly.

### 2.6 Safe Antigravity CLI (`agy`) Execution

- **Forbidden Flags**: Invoking `agy` with `--dangerously-skip-permissions` is strictly prohibited under all circumstances.
- **Sandbox Compliance**: Agent operations must run within standard tool permission boundaries and respect OS-level sandbox isolation.

### 2.7 System Integrity & Non-Invasiveness

- **No Unauthorized Daemons**: The orchestrator must not install global `launchd` / `systemd` daemons without explicit user consent.
- **No Global Shell Mutation**: The orchestrator will not modify global shell configuration files (`~/.zshrc`, `~/.bashrc`, `~/.profile`).
- **No Cross-Project Interference**: Operations are strictly scoped to the configured workspace and cannot alter external project repositories (such as `xingce` or sibling tools).

---

## 3. Threat Model & Mitigations

| Threat                                            | Impact                                      | Mitigation Enforced                                                                             |
| :------------------------------------------------ | :------------------------------------------ | :---------------------------------------------------------------------------------------------- |
| **Agent hallucinating destructive shell command** | Loss of local files or workspace corruption | Worktree isolation + prohibition of permission bypass flags (`--dangerously-skip-permissions`). |
| **Accidental secret leak**                        | Exposed API tokens or GitHub credentials    | Strict `.gitignore`, secret scrubbing in logs, and no token persistence in codebase.            |
| **Unintended code merge to production**           | Defective code shipped to users             | Hard block on automatic merge commands; mandatory human PR approval gate.                       |
| **Review tool mutating code during analysis**     | Unaudited and unverified modifications      | Codex CLI runs strictly in read-only inspection mode.                                           |
| **Cross-repository pollution**                    | Accidental changes to adjacent projects     | Strict workspace path validation; operations confined to target repository.                     |
