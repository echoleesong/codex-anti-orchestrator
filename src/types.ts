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
  signal?: NodeJS.Signals | string | null;
  timedOut?: boolean;
  error?: Error;
}

export interface SafeExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  rejectForbiddenFlags?: boolean;
  forbiddenFlags?: string[];
}

export type CommandExecutor = (
  file: string,
  args: string[],
  options?: SafeExecOptions
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
  | 'AGY_VALIDATING'
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
  lastReviewVerdict?: CodexVerdict;
  lastTestPassed?: boolean;
  humanVerificationChecklist?: string[];
  liveVerification?: LiveVerificationResult;
  ciWaitAttempts?: number;
  ciWaitHistory?: CIWaitObservation[];
}

export type TaskEventSource = 'ORCHESTRATOR' | 'ANTI' | 'CODEX' | 'GITHUB_CI';

export interface TaskEvent {
  timestamp: string;
  source: TaskEventSource;
  message: string;
  detail?: string;
}

export interface CIWaitObservation {
  timestamp: string;
  attempt: number;
  status: 'PENDING' | 'PASSING' | 'FAILING' | 'UNAVAILABLE';
  summary: string;
  checks: PRCheckItem[];
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
  events?: TaskEvent[];
}

export interface CreateTaskOptions {
  repoPath: string;
  prompt: string;
  baseBranch?: string;
  stateDir?: string;
  executor?: CommandExecutor;
  allowedBaseDir?: string;
  maxReviewCycles?: number;
}

export interface ResumeTaskOptions {
  override?: boolean;
  guidance?: string;
  stateDir?: string;
  executor?: CommandExecutor;
}

// ----------------------------------------------------------------------
// Phase 3: Adapters & State Loop Types
// ----------------------------------------------------------------------

export type CodexVerdict = 'APPROVE' | 'CHANGES_REQUIRED' | 'NEEDS_USER_DECISION';

export interface CodexReviewResult {
  verdict: CodexVerdict;
  summary: string;
  blockingIssues: string[];
  warnings: string[];
  humanVerificationChecklist: string[];
  parsedCleanly: boolean;
  rawOutput?: string;
}

export interface CodexReviewOptions {
  worktreePath: string;
  baseBranch?: string;
  diff?: string;
  prNumberOrBranch?: string;
  executor?: CommandExecutor;
  timeoutMs?: number;
}

export interface AgyExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface AgyRunOptions {
  worktreePath: string;
  prompt: string;
  model?: string;
  printTimeout?: string;
  stateDir?: string;
  targetRepoPath?: string;
  executor?: CommandExecutor;
  timeoutMs?: number;
}

export interface AgyFixFeedback {
  blockingIssues: string[];
  warnings?: string[];
  testErrors?: string;
}

export type LiveVerificationStatus = 'PASSED' | 'FAILED' | 'UNAVAILABLE';

/** Evidence emitted by Anti after it starts and checks the changed application locally. */
export interface LiveVerificationResult {
  status: LiveVerificationStatus;
  command?: string;
  url?: string;
  checks: string[];
  summary: string;
  parsedCleanly: boolean;
  rawOutput?: string;
}

export interface PROperationResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  title?: string;
  body?: string;
  state?: string;
  error?: string;
}

export interface CreatePROptions {
  worktreePath: string;
  targetRepoPath?: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  executor?: CommandExecutor;
}

export interface ViewPROptions {
  worktreePath: string;
  targetRepoPath?: string;
  prNumberOrBranch: string;
  executor?: CommandExecutor;
}

export interface UpdatePROptions {
  worktreePath: string;
  targetRepoPath?: string;
  prNumberOrBranch?: string;
  title?: string;
  body?: string;
  comment?: string;
  executor?: CommandExecutor;
}

export interface PRCheckItem {
  name: string;
  state: string;
  bucket: string;
  description?: string;
  link?: string;
  workflow?: string;
  status?: string;
  conclusion?: string;
}

export interface PRChecksResult {
  success: boolean;
  allPassing: boolean;
  checks: PRCheckItem[];
  error?: string;
}

export interface CIWaitOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface RunTaskLoopOptions {
  taskId: string;
  stateDir?: string;
  executor?: CommandExecutor;
  autoApprove?: boolean;
}

// ----------------------------------------------------------------------
// Phase 4: MCP Server Types
// ----------------------------------------------------------------------

export interface IOrchestrator {
  createTask(options: CreateTaskOptions): Promise<TaskRecord>;
  runTaskLoop(
    taskId: string,
    loopOptions?: {
      executor?: CommandExecutor;
      maxReviewCycles?: number;
      testRunner?: (
        worktreePath: string,
        executor: CommandExecutor
      ) => Promise<{ pass: boolean; errors?: string }>;
      ciWait?: CIWaitOptions;
    }
  ): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  listTasks(): Promise<TaskRecord[]>;
  cancelTask(taskId: string, reason?: string): Promise<TaskRecord>;
  resumeTask(taskId: string, options?: ResumeTaskOptions): Promise<TaskRecord>;
  getStateDir?(): string;
  getAllowedBaseDir?(): string;
}

export interface OrchestratorMcpServerOptions {
  orchestrator?: IOrchestrator;
  stateDir?: string;
  allowedBaseDir?: string;
  executor?: CommandExecutor;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  monitorLauncher?: {
    ensureStarted(): Promise<{ url: string; opened: boolean }>;
  };
}
