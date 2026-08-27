import { describe, expect, it } from 'vitest';
import {
  checkAgy,
  checkCodex,
  checkGh,
  checkGit,
  checkNode,
  formatDoctorReport,
  runDoctor,
} from '../src/doctor/doctor.js';
import type { CommandExecutor, ExecOutput } from '../src/types.js';

describe('Doctor Diagnostic Checks', () => {
  const createMockExecutor = (responses: Record<string, Partial<ExecOutput>>): CommandExecutor => {
    return async (file: string, args: string[]): Promise<ExecOutput> => {
      const fullCmd = `${file} ${args.join(' ')}`.trim();
      const matchedKey = Object.keys(responses).find((key) => fullCmd.startsWith(key));
      const res = matchedKey ? responses[matchedKey] : undefined;

      return {
        exitCode: res?.exitCode ?? 0,
        stdout: res?.stdout ?? '',
        stderr: res?.stderr ?? '',
        error: res?.error,
      };
    };
  };

  describe('checkNode', () => {
    it('should pass on modern Node.js versions (>= 20)', async () => {
      const result = await checkNode();
      expect(result.id).toBe('node');
      expect(result.status).toBe('ok');
      expect(result.version).toBeDefined();
    });
  });

  describe('checkGit', () => {
    it('should return ok when inside a valid git repository with remote', async () => {
      const mock = createMockExecutor({
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git rev-parse --is-inside-work-tree': { stdout: 'true\n' },
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git remote get-url origin': {
          stdout: 'https://github.com/test/repo.git\n',
        },
      });

      const result = await checkGit(mock, '/fake/path');
      expect(result.status).toBe('ok');
      expect(result.message).toContain('main');
      expect(result.message).toContain('https://github.com/test/repo.git');
    });

    it('should return error when git is not installed', async () => {
      const mock = createMockExecutor({
        'git --version': { exitCode: 127, stderr: 'command not found' },
      });

      const result = await checkGit(mock, '/fake/path');
      expect(result.status).toBe('error');
      expect(result.fixSuggestion).toContain('Install Git');
    });

    it('should return error when directory is not a git repository', async () => {
      const mock = createMockExecutor({
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git rev-parse --is-inside-work-tree': {
          exitCode: 128,
          stderr: 'fatal: not a git repository',
        },
      });

      const result = await checkGit(mock, '/fake/path');
      expect(result.status).toBe('error');
      expect(result.message).toContain('not inside a Git repository');
      expect(result.fixSuggestion).toContain('git init');
    });
  });

  describe('checkGh', () => {
    it('should return ok when gh is installed and authenticated', async () => {
      const mock = createMockExecutor({
        'gh --version': { stdout: 'gh version 2.45.0 (2024-03-01)\n' },
        'gh auth status': {
          stdout: 'github.com\n  ✓ Logged in to github.com account octocat\n',
        },
      });

      const result = await checkGh(mock);
      expect(result.status).toBe('ok');
      expect(result.version).toBe('v2.45.0');
      expect(result.message).toContain('octocat');
    });

    it('should return error when gh is not installed', async () => {
      const mock = createMockExecutor({
        'gh --version': { exitCode: 127, stderr: 'gh: command not found' },
      });

      const result = await checkGh(mock);
      expect(result.status).toBe('error');
      expect(result.fixSuggestion).toContain('Install GitHub CLI');
    });

    it('should return error when gh is unauthenticated', async () => {
      const mock = createMockExecutor({
        'gh --version': { stdout: 'gh version 2.45.0\n' },
        'gh auth status': {
          exitCode: 1,
          stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
        },
      });

      const result = await checkGh(mock);
      expect(result.status).toBe('error');
      expect(result.fixSuggestion).toContain('gh auth login');
    });
  });

  describe('checkAgy', () => {
    it('should return ok when agy is installed', async () => {
      const mock = createMockExecutor({
        'agy --version': { stdout: '1.1.21\n' },
      });

      const result = await checkAgy(mock);
      expect(result.status).toBe('ok');
      expect(result.version).toBe('1.1.21');
    });

    it('should return error when agy is missing', async () => {
      const mock = createMockExecutor({
        'agy --version': { exitCode: 127, stderr: 'agy: not found' },
      });

      const result = await checkAgy(mock);
      expect(result.status).toBe('error');
      expect(result.fixSuggestion).toContain('Install Antigravity CLI');
    });
  });

  describe('checkCodex', () => {
    it('should return ok when codex CLI is installed', async () => {
      const mock = createMockExecutor({
        'codex --version': { stdout: 'codex-cli 0.147.0\n' },
      });

      const result = await checkCodex(mock);
      expect(result.status).toBe('ok');
      expect(result.version).toBe('codex-cli 0.147.0');
    });

    it('should return error when codex CLI is missing', async () => {
      const mock = createMockExecutor({
        'codex --version': { exitCode: 127, stderr: 'codex: not found' },
      });

      const result = await checkCodex(mock);
      expect(result.status).toBe('error');
      expect(result.fixSuggestion).toContain('Install Codex CLI');
    });
  });

  describe('runDoctor & formatDoctorReport', () => {
    it('should produce a passing report when all tools and git repo are valid', async () => {
      const mock = createMockExecutor({
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git rev-parse --is-inside-work-tree': { stdout: 'true\n' },
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git remote get-url origin': { stdout: 'https://github.com/test/repo.git\n' },
        'gh --version': { stdout: 'gh version 2.45.0\n' },
        'gh auth status': { stdout: 'Logged in to github.com account testuser\n' },
        'agy --version': { stdout: '1.1.21\n' },
        'codex --version': { stdout: 'codex-cli 0.147.0\n' },
      });

      const report = await runDoctor({ executor: mock, cwd: '/test' });
      expect(report.allOk).toBe(true);
      expect(report.hasErrors).toBe(false);
      expect(report.checks.length).toBe(5);

      const formatted = formatDoctorReport(report);
      expect(formatted).toContain('All prerequisites are satisfied');
      expect(formatted).toContain('✓ Antigravity CLI (agy)');
      expect(formatted).toContain('✓ OpenAI Codex CLI (codex)');
      expect(formatted).toContain('✓ GitHub CLI (gh)');
    });

    it('should flag errors when prerequisites fail', async () => {
      const mock = createMockExecutor({
        'git --version': { stdout: 'git version 2.40.0\n' },
        'git rev-parse --is-inside-work-tree': { stdout: 'true\n' },
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git remote get-url origin': { stdout: 'https://github.com/test/repo.git\n' },
        'gh --version': { stdout: 'gh version 2.45.0\n' },
        'gh auth status': { exitCode: 1, stderr: 'unauthenticated' },
        'agy --version': { exitCode: 127, stderr: 'not found' },
        'codex --version': { stdout: 'codex-cli 0.147.0\n' },
      });

      const report = await runDoctor({ executor: mock, cwd: '/test' });
      expect(report.allOk).toBe(false);
      expect(report.hasErrors).toBe(true);

      const formatted = formatDoctorReport(report);
      expect(formatted).toContain('ERROR - One or more critical prerequisites are missing');
      expect(formatted).toContain('✗ Antigravity CLI (agy)');
      expect(formatted).toContain('✗ GitHub CLI (gh) Authentication');
    });

    it('should strictly execute only read-only commands without mutating the system', async () => {
      const executedCommands: string[] = [];
      const spyExecutor: CommandExecutor = async (file, args) => {
        const cmd = `${file} ${args.join(' ')}`;
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: 'mocked', stderr: '' };
      };

      await runDoctor({ executor: spyExecutor, cwd: '/test' });

      // Invariant: no mutating commands permitted
      for (const cmd of executedCommands) {
        expect(cmd).not.toMatch(/\b(commit|push|init|login|delete|create|install|rm|mkdir)\b/);
      }
    });
  });
});
