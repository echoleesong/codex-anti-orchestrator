import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(process.cwd(), 'src/cli.ts');

describe('CLI Integration Tests (Environment Isolated)', () => {
  let mockBinDir: string;
  let failingBinDir: string;
  let mockEnv: Record<string, string>;
  let failingEnv: Record<string, string>;

  beforeAll(() => {
    mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-cli-bin-'));
    failingBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failing-cli-bin-'));

    // 1. Success stubs
    const ghScript = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.45.0 (2024-03-01)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com"
  echo "  ✓ Logged in to github.com account ci-test-user (keyring)"
  exit 0
fi
exit 0
`;
    const agyScript = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.1.21"
  exit 0
fi
exit 0
`;
    const codexScript = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.147.0"
  exit 0
fi
exit 0
`;

    fs.writeFileSync(path.join(mockBinDir, 'gh'), ghScript, { mode: 0o755 });
    fs.writeFileSync(path.join(mockBinDir, 'agy'), agyScript, { mode: 0o755 });
    fs.writeFileSync(path.join(mockBinDir, 'codex'), codexScript, { mode: 0o755 });

    mockEnv = {
      ...process.env,
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
    };

    // 2. Failure stubs (gh unauthenticated, agy and codex missing)
    const ghFailScript = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.45.0"
  exit 0
fi
echo "You are not logged into any GitHub hosts." >&2
exit 1
`;
    const toolFailScript = `#!/bin/sh
exit 127
`;

    fs.writeFileSync(path.join(failingBinDir, 'gh'), ghFailScript, { mode: 0o755 });
    fs.writeFileSync(path.join(failingBinDir, 'agy'), toolFailScript, { mode: 0o755 });
    fs.writeFileSync(path.join(failingBinDir, 'codex'), toolFailScript, { mode: 0o755 });

    failingEnv = {
      ...process.env,
      PATH: `${failingBinDir}${path.delimiter}${process.env.PATH || ''}`,
    };
  });

  afterAll(() => {
    fs.rmSync(mockBinDir, { recursive: true, force: true });
    fs.rmSync(failingBinDir, { recursive: true, force: true });
  });

  it('should output clean, valid JSON report on doctor --json with exit code 0 when prerequisites pass', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, 'doctor', '--json'], {
      cwd: process.cwd(),
      timeout: 15000,
      env: mockEnv,
    });

    expect(stderr.trim()).toBe('');

    let parsed: DoctorReport;
    expect(() => {
      parsed = JSON.parse(stdout.trim());
    }).not.toThrow();

    expect(parsed!).toBeDefined();
    expect(parsed!.allOk).toBe(true);
    expect(parsed!.hasErrors).toBe(false);
    expect(Array.isArray(parsed!.checks)).toBe(true);

    const checkIds = parsed!.checks.map((c) => c.id);
    expect(checkIds).toContain('node');
    expect(checkIds).toContain('git');
    expect(checkIds).toContain('gh');
    expect(checkIds).toContain('agy');
    expect(checkIds).toContain('codex');
  });

  it('should output valid JSON and exit code 1 when prerequisites fail in isolated environment', async () => {
    try {
      await execFileAsync('npx', ['tsx', cliPath, 'doctor', '--json'], {
        cwd: process.cwd(),
        timeout: 15000,
        env: failingEnv,
      });
      expect.unreachable('Expected doctor command to exit with non-zero code');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stderr?.trim() || '').toBe('');

      // Even on failure, stdout must be valid JSON report
      const stdout = execErr.stdout || '';
      let parsed: DoctorReport;
      expect(() => {
        parsed = JSON.parse(stdout.trim());
      }).not.toThrow();

      expect(parsed!).toBeDefined();
      expect(parsed!.hasErrors).toBe(true);
      expect(parsed!.allOk).toBe(false);
    }
  });

  it('should output clean human-readable report on doctor command', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, 'doctor'], {
      cwd: process.cwd(),
      timeout: 15000,
      env: mockEnv,
    });

    expect(stderr.trim()).toBe('');
    expect(stdout).toContain('codex-anti-orchestrator Doctor Report');
    expect(stdout).toContain('Node.js Runtime');
    expect(stdout).toContain('Git Repository Status');
    expect(stdout).toContain('GitHub CLI (gh)');
    expect(stdout).toContain('Antigravity CLI (agy)');
    expect(stdout).toContain('OpenAI Codex CLI (codex)');
    expect(stdout).toContain('Result:');
  });

  it('should display version information on --version flag', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, '--version'], {
      cwd: process.cwd(),
      timeout: 10000,
    });

    expect(stderr.trim()).toBe('');
    expect(stdout.trim()).toBe('codex-anti-orchestrator v0.1.0');
  });

  it('should display usage help on --help flag', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, '--help'], {
      cwd: process.cwd(),
      timeout: 10000,
    });

    expect(stderr.trim()).toBe('');
    expect(stdout).toContain('USAGE:');
    expect(stdout).toContain('COMMANDS:');
    expect(stdout).toContain('OPTIONS:');
  });
});
