import type { CheckResult, CommandExecutor, DoctorOptions, DoctorReport } from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export async function checkNode(): Promise<CheckResult> {
  const version = process.version;
  const major = parseInt(version.replace(/^v/, '').split('.')[0], 10);

  if (major >= 20) {
    return {
      id: 'node',
      name: 'Node.js Runtime',
      status: 'ok',
      version,
      message: `Node.js ${version} meets minimum requirement (>= v20.0.0)`,
    };
  }

  return {
    id: 'node',
    name: 'Node.js Runtime',
    status: 'error',
    version,
    message: `Node.js ${version} is below minimum requirement (>= v20.0.0)`,
    fixSuggestion: 'Please upgrade to Node.js v20 or higher (v24 LTS recommended).',
  };
}

export async function checkGit(
  executor: CommandExecutor,
  cwd: string = process.cwd()
): Promise<CheckResult> {
  const versionRes = await executor('git', ['--version'], { cwd });
  if (versionRes.exitCode !== 0) {
    return {
      id: 'git',
      name: 'Git Version Control',
      status: 'error',
      message: 'Git executable not found in PATH.',
      fixSuggestion: 'Install Git (https://git-scm.com/) and ensure it is available in PATH.',
    };
  }

  const gitVersion = versionRes.stdout.trim();

  const isRepoRes = await executor('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (isRepoRes.exitCode !== 0 || isRepoRes.stdout.trim() !== 'true') {
    return {
      id: 'git',
      name: 'Git Repository Status',
      status: 'error',
      version: gitVersion,
      message: `Current directory (${cwd}) is not inside a Git repository.`,
      fixSuggestion: 'Run "git init" or navigate to an initialized Git repository.',
    };
  }

  const branchRes = await executor('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = branchRes.stdout.trim() || 'unknown';

  const remoteRes = await executor('git', ['remote', 'get-url', 'origin'], { cwd });
  const remote = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : 'none';

  return {
    id: 'git',
    name: 'Git Repository Status',
    status: 'ok',
    version: gitVersion,
    message: `Inside Git repository (branch: ${branch}, remote origin: ${remote})`,
    details: `Branch: ${branch}\nRemote: ${remote}`,
  };
}

export async function checkGh(executor: CommandExecutor): Promise<CheckResult> {
  const versionRes = await executor('gh', ['--version']);
  if (versionRes.exitCode !== 0) {
    return {
      id: 'gh',
      name: 'GitHub CLI (gh)',
      status: 'error',
      message: 'GitHub CLI (gh) executable not found in PATH.',
      fixSuggestion: 'Install GitHub CLI (https://cli.github.com/) and run "gh auth login".',
    };
  }

  const ghVersionMatch = versionRes.stdout.match(/gh version ([^\s]+)/);
  const ghVersion = ghVersionMatch
    ? `v${ghVersionMatch[1]}`
    : versionRes.stdout.trim().split('\n')[0];

  const authRes = await executor('gh', ['auth', 'status']);
  const combinedOutput = `${authRes.stdout}\n${authRes.stderr}`;

  if (authRes.exitCode !== 0) {
    return {
      id: 'gh',
      name: 'GitHub CLI (gh) Authentication',
      status: 'error',
      version: ghVersion,
      message: 'GitHub CLI is not authenticated or token is invalid.',
      details: combinedOutput.trim(),
      fixSuggestion: 'Run "gh auth login" to authenticate with GitHub.',
    };
  }

  const accountMatch = combinedOutput.match(/Logged in to [^\s]+ account ([^\s\(\)]+)/i);
  const accountName = accountMatch ? accountMatch[1] : 'authenticated';

  return {
    id: 'gh',
    name: 'GitHub CLI (gh)',
    status: 'ok',
    version: ghVersion,
    message: `Authenticated as GitHub user: ${accountName}`,
    details: combinedOutput.trim(),
  };
}

export async function checkAgy(executor: CommandExecutor): Promise<CheckResult> {
  const versionRes = await executor('agy', ['--version']);
  if (versionRes.exitCode !== 0) {
    return {
      id: 'agy',
      name: 'Antigravity CLI (agy)',
      status: 'error',
      message: 'Antigravity CLI (agy) executable not found in PATH.',
      fixSuggestion: 'Install Antigravity CLI (agy) and verify it with "agy --version".',
    };
  }

  const version = versionRes.stdout.trim().split('\n')[0];
  return {
    id: 'agy',
    name: 'Antigravity CLI (agy)',
    status: 'ok',
    version: version || 'installed',
    message: `Antigravity CLI installed (${version || 'version unknown'})`,
  };
}

export async function checkCodex(executor: CommandExecutor): Promise<CheckResult> {
  const versionRes = await executor('codex', ['--version']);
  if (versionRes.exitCode !== 0) {
    return {
      id: 'codex',
      name: 'OpenAI Codex CLI (codex)',
      status: 'error',
      message: 'OpenAI Codex CLI (codex) executable not found in PATH.',
      fixSuggestion: 'Install Codex CLI (codex) and verify it with "codex --version".',
    };
  }

  const version = versionRes.stdout.trim().split('\n')[0];
  return {
    id: 'codex',
    name: 'OpenAI Codex CLI (codex)',
    status: 'ok',
    version: version || 'installed',
    message: `OpenAI Codex CLI installed (${version || 'version unknown'})`,
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const executor = options.executor || defaultExecutor;
  const cwd = options.cwd || process.cwd();

  const checks: CheckResult[] = [];

  // Run all read-only diagnostic checks
  checks.push(await checkNode());
  checks.push(await checkGit(executor, cwd));
  checks.push(await checkGh(executor));
  checks.push(await checkAgy(executor));
  checks.push(await checkCodex(executor));

  const hasErrors = checks.some((c) => c.status === 'error');
  const hasWarnings = checks.some((c) => c.status === 'warn');
  const allOk = !hasErrors && !hasWarnings;

  return {
    allOk,
    hasErrors,
    hasWarnings,
    checks,
    timestamp: new Date().toISOString(),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('======================================================');
  lines.push('        codex-anti-orchestrator Doctor Report         ');
  lines.push('======================================================');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');

  for (const check of report.checks) {
    let icon = '✓';
    if (check.status === 'warn') icon = '⚠';
    if (check.status === 'error') icon = '✗';

    const versionStr = check.version ? ` [${check.version}]` : '';
    lines.push(`${icon} ${check.name}${versionStr}`);
    lines.push(`  Status : ${check.status.toUpperCase()}`);
    lines.push(`  Message: ${check.message}`);

    if (check.fixSuggestion && check.status !== 'ok') {
      lines.push(`  Fix    : ${check.fixSuggestion}`);
    }
    lines.push('');
  }

  lines.push('------------------------------------------------------');
  if (report.allOk) {
    lines.push('Result: All prerequisites are satisfied! Ready for orchestration.');
  } else if (report.hasErrors) {
    lines.push('Result: ERROR - One or more critical prerequisites are missing.');
  } else {
    lines.push('Result: WARNING - Some non-critical warnings detected.');
  }
  lines.push('======================================================');

  return lines.join('\n');
}
