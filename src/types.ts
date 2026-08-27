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
