export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  version?: string;
  details?: string;
  fixSuggestion?: string;
}

export interface DoctorReport {
  allOk: boolean;
  hasErrors: boolean;
  hasWarnings: boolean;
  checks: CheckResult[];
  timestamp: string;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandExecutor = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
) => Promise<ExecOutput>;

export interface DoctorOptions {
  cwd?: string;
  executor?: CommandExecutor;
}

// ----------------------------------------------------------------------
// Phase 2: State Machine & Task Types
// ----------------------------------------------------------------------

export type TaskState =
  | 'IDLE'
  | 'INITIALIZING'
  | 'WORKTREE_PREPARING'
  | 'WORKTREE_READY'
  | 'AGY_DEVELOPING'
  | 'PR_CREATING'
  | 'CODEX_REVIEWING'
  | 'REVIEW_EVALUATING'
  | 'AGY_FIXING'
  | 'PR_UPDATING'
  | 'AWAITING_HUMAN_APPROVAL'
  | 'NEEDS_USER_DECISION'
  | 'AWAITING_HUMAN_OVERRIDE'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED';

export interface StateTransitionRecord {
  from: TaskState;
  to: TaskState;
  timestamp: string;
  reason?: string;
  error?: string;
}

export interface TaskDiagnostics {
  lastError?: string;
  failedState?: TaskState;
  gitLockDetected?: boolean;
  gitLockPath?: string;
  uncommittedChanges?: string[];
  reviewCycles: number;
  maxReviewCycles: number;
  resumePossible: boolean;
  resumeTargetState?: TaskState;
  resumeInstructions?: string;
  worktreePreserved: boolean;
}

export interface TaskRecord {
  id: string;
  targetRepoPath: string;
  baseBranch: string;
  taskBranch: string;
  worktreePath: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  transitions: StateTransitionRecord[];
  diagnostics: TaskDiagnostics;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskOptions {
  repoPath: string;
  prompt: string;
  baseBranch?: string;
  stateDir?: string;
  executor?: CommandExecutor;
  allowedBaseDir?: string;
}

export interface ResumeTaskOptions {
  override?: boolean;
  guidance?: string;
  stateDir?: string;
  executor?: CommandExecutor;
}
