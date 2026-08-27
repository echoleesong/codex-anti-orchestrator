import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = resolve(process.cwd(), 'src/cli.ts');

describe('CLI Integration Tests (Real Process Execution)', () => {
  it('should output clean, valid JSON report on doctor --json with empty stderr', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, 'doctor', '--json'], {
      cwd: process.cwd(),
      timeout: 15000,
    });

    expect(stderr.trim()).toBe('');

    // Must be strictly JSON-parseable without surrounding text
    let parsed: DoctorReport;
    expect(() => {
      parsed = JSON.parse(stdout.trim());
    }).not.toThrow();

    expect(parsed!).toBeDefined();
    expect(typeof parsed!.allOk).toBe('boolean');
    expect(typeof parsed!.hasErrors).toBe('boolean');
    expect(typeof parsed!.hasWarnings).toBe('boolean');
    expect(Array.isArray(parsed!.checks)).toBe(true);

    const checkIds = parsed!.checks.map((c) => c.id);
    expect(checkIds).toContain('node');
    expect(checkIds).toContain('git');
    expect(checkIds).toContain('gh');
    expect(checkIds).toContain('agy');
    expect(checkIds).toContain('codex');
  });

  it('should output clean human-readable report on doctor command', async () => {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', cliPath, 'doctor'], {
      cwd: process.cwd(),
      timeout: 15000,
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
    expect(stdout).toContain("OPTIONS for 'doctor':");
  });
});
