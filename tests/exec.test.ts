import { describe, expect, it } from 'vitest';
import {
  checkForbiddenFlags,
  defaultExecutor,
  FORBIDDEN_FLAGS,
  redactSecrets,
  safeExecute,
} from '../src/utils/exec.js';

describe('Safe Child Process Execution & Secret Redaction', () => {
  describe('checkForbiddenFlags', () => {
    it('should detect forbidden flags like --dangerously-skip-permissions', () => {
      expect(checkForbiddenFlags(['--dangerously-skip-permissions']).forbidden).toBe(true);
      expect(checkForbiddenFlags(['--dangerously-skip-permissions=true']).forbidden).toBe(true);
      expect(
        checkForbiddenFlags(['run', '-p', 'task', '--dangerously-skip-permissions']).forbidden
      ).toBe(true);
    });

    it('should allow safe flags and arguments', () => {
      expect(checkForbiddenFlags(['--sandbox', '-p', 'hello']).forbidden).toBe(false);
      expect(checkForbiddenFlags(['--json', '--all', 'main']).forbidden).toBe(false);
    });
  });

  describe('redactSecrets', () => {
    it('should redact GitHub personal access tokens and OAuth tokens', () => {
      const input =
        'Error with token ghp_1234567890abcdef1234567890abcdef1234 and PAT github_pat_11AAAAAAA01234567890abcdef_1234567890abcdef1234567890';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('ghp_1234567890abcdef1234567890abcdef1234');
      expect(redacted).not.toContain(
        'github_pat_11AAAAAAA01234567890abcdef_1234567890abcdef1234567890'
      );
      expect(redacted).toContain('[REDACTED_GITHUB_TOKEN]');
    });

    it('should redact OpenAI API keys', () => {
      const input = 'Using key sk-proj-1234567890abcdef1234567890abcdef for completion';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('sk-proj-1234567890abcdef1234567890abcdef');
      expect(redacted).toContain('[REDACTED_OPENAI_KEY]');
    });

    it('should redact Anthropic API keys', () => {
      const input = 'Auth sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890');
      expect(redacted).toContain('[REDACTED_ANTHROPIC_KEY]');
    });

    it('should redact Bearer authorization tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature');
      expect(redacted).toContain('Bearer [REDACTED_BEARER_TOKEN]');
    });

    it('should redact basic auth passwords in URLs', () => {
      const input = 'Clone URL: https://bot_user:secret_password_123@github.com/org/repo.git';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('secret_password_123');
      expect(redacted).toContain('https://bot_user:[REDACTED_PASSWORD]@github.com/org/repo.git');
    });

    it('should redact generic secret assignments in logs', () => {
      const input =
        'Config loaded: api_key="my_super_secret_token_123" and password: secret_pass_99';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('my_super_secret_token_123');
      expect(redacted).not.toContain('secret_pass_99');
      expect(redacted).toContain('[REDACTED_SECRET]');
    });
  });

  describe('safeExecute', () => {
    it('should strictly reject forbidden flags without spawning process', async () => {
      const res = await safeExecute('node', [
        '-e',
        'console.log(1)',
        '--dangerously-skip-permissions',
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(
        'Forbidden command flag detected: "--dangerously-skip-permissions"'
      );
      expect(res.error).toBeDefined();
    });

    it('should execute commands safely using argument arrays only', async () => {
      const res = await safeExecute('node', ['-e', 'console.log("safe execution")']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('safe execution');
      expect(res.stderr).toBe('');
    });

    it('should redact secrets in process stdout and stderr', async () => {
      const res = await safeExecute('node', [
        '-e',
        'console.log("Token: ghp_1234567890abcdef1234567890abcdef1234"); console.error("Key: sk-proj-1234567890abcdef1234567890abcdef");',
      ]);

      expect(res.stdout).not.toContain('ghp_1234567890abcdef1234567890abcdef1234');
      expect(res.stdout).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(res.stderr).not.toContain('sk-proj-1234567890abcdef1234567890abcdef');
      expect(res.stderr).toContain('[REDACTED_OPENAI_KEY]');
    });

    it('should handle process timeout gracefully', async () => {
      const res = await safeExecute('node', ['-e', 'setTimeout(() => {}, 5000)'], {
        timeoutMs: 100,
      });

      expect(res.timedOut).toBe(true);
      expect(res.exitCode).not.toBe(0);
    });

    it('should handle non-zero exit codes with bounded buffers', async () => {
      const res = await safeExecute('node', [
        '-e',
        'console.error("fatal error"); process.exit(42);',
      ]);
      expect(res.exitCode).toBe(42);
      expect(res.stderr).toContain('fatal error');
    });
  });
});
