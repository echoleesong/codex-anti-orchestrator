# codex-anti-orchestrator

> **Local Orchestrator for Codex Review, Antigravity Development, and GitHub PR Handoff.**

`codex-anti-orchestrator` is a lightweight, local-first orchestration daemon designed to bridge **Codex App (MCP)**, **Antigravity CLI (`agy`)**, **GitHub Pull Requests**, and **OpenAI Codex CLI (`codex`)** into a structured, secure, and human-supervised automated development loop.

---

## 1. Target Architecture & Workflow

The orchestration loop follows a closed-loop pipeline where development, review, and fix iterations happen autonomously within isolated worktrees, while merge and deployment decisions remain strictly under human control.

```mermaid
flowchart TD
    subgraph Trigger
        A[Codex App MCP] -->|1. Dispatch task request| B[Local Daemon]
    end

    subgraph Local Execution & Development
        B -->|2. Prepare isolated worktree| C[Git Worktree]
        B -->|3. Run development task| D[Antigravity CLI: agy]
        D -->|4. Generate changes & tests| C
    end

    subgraph PR & Code Review
        C -->|5. Commit & push branch| E[GitHub PR]
        E -->|6. Trigger read-only review| F[Codex CLI]
        F -->|7. Post review findings| B
    end

    subgraph Decision & Handoff
        B -->|8. Issues found & cycles remaining| D
        B -->|9. Review passed or max cycles reached| G[Awaiting Human Approval]
        G -->|10. Human merges PR manually| H[Completed]
    end
```

---

## 2. Component Responsibilities

| Component                   | Responsibility                                                                                                        | Constraints & Permissions                                                                                         |
| :-------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **Codex App MCP**           | User-facing entrypoint for receiving development instructions and task dispatch.                                      | Dispatches task descriptors to the local daemon; does not execute file changes directly.                          |
| **Local Daemon**            | Manages the state machine, enforces security boundaries, allocates isolated worktrees, and controls iteration counts. | Strictly local process; does not install root/launchd services without explicit user intervention.                |
| **Antigravity CLI (`agy`)** | Executes coding tasks, test generation, and fixes inside the assigned worktree.                                       | Restricted to worktree directory; forbidden from using dangerous bypass flags (`--dangerously-skip-permissions`). |
| **GitHub PR**               | Central collaboration artifact, audit trail, and security boundary for changes.                                       | Minimal token scopes (`repo`, `workflow`); no automatic merge.                                                    |
| **Codex CLI (`codex`)**     | Performs automated, read-only static and semantic code reviews on generated diffs.                                    | Strictly read-only; cannot modify source files, push commits, or merge PRs.                                       |

---

## 3. Non-Goals

- **No Automatic Merging or Deployment**: Merging to `main` and production deployments require explicit human review and authorization.
- **No Direct Mutation on Primary Worktree**: Tasks are strictly isolated in temporary Git worktrees to prevent workspace pollution.
- **No Unsafe Permission Bypassing**: Tools like `agy` must run under standard permission and sandbox boundaries.
- **No Cloud SaaS Dependency**: Orchestration logic runs 100% locally on the developer's machine.
- **No Credential Storage in Repository**: Tokens and machine secrets must never be committed to git, written to logs, or embedded in code.

---

## 4. Prerequisites

Before running the orchestrator, ensure the following tools are installed and properly configured on your machine:

1. **Node.js**: `v20.0.0` or higher (v24+ recommended).
2. **Git**: `2.30.0` or higher with worktree support.
3. **GitHub CLI (`gh`)**: Installed and authenticated:
   ```bash
   gh auth status
   ```
4. **Antigravity CLI (`agy`)**: Installed and available in `$PATH`:
   ```bash
   agy --version
   ```
5. **OpenAI Codex CLI (`codex`)**: Installed and available in `$PATH`:
   ```bash
   codex --version
   ```

---

## 5. Quick Start & Commands

### Diagnostic Health Check (`doctor`)

The `doctor` command verifies all system prerequisites and repository state without modifying any files or credentials:

```bash
# Run via npm
npm run doctor

# Or run directly with tsx
npx tsx src/cli.ts doctor
```

### Development & Testing

```bash
# Install dependencies
npm install

# Type checking
npm run typecheck

# Run test suite
npm test

# Format checking
npm run format:check

# Format code
npm run format

# Build TypeScript to dist/
npm run build
```

---

## 6. Documentation Index

- [Security Model & Constraints](file:///Users/lisong/code/tools/codex-anti-orchestrator/docs/security.md): Detailed isolation, token safety, read-only constraints, and permission boundaries.
- [State Machine & Failure Handling](file:///Users/lisong/code/tools/codex-anti-orchestrator/docs/state-machine.md): Task state definitions, transition matrix, retry backoff, and stop conditions.
