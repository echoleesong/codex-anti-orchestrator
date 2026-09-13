import os from 'node:os';
import { redactSecrets } from '../utils/exec.js';

export const DEFAULT_MAX_PROMPT_LENGTH = 12_000;

export interface SanitizePromptOptions {
  worktreePath?: string;
  targetRepoPath?: string;
  stateDir?: string;
  allowedBaseDir?: string;
  maxLength?: number;
}

const COMMON_ENV_IGNORABLE_VALUES = new Set([
  'true',
  'false',
  'darwin',
  'linux',
  'win32',
  'arm64',
  'x64',
  'none',
  'default',
  'unknown',
]);

/**
 * Sanitizes prompt text before audit persistence and monitor API presentation.
 * Enforces:
 * 1. Secret and credential redaction (via redactSecrets)
 * 2. Absolute filesystem path suppression across macOS, Linux, and Windows
 * 3. Environment variable assignment and process.env value redaction
 * 4. Bounded character length limits
 */
export function sanitizePromptAuditText(
  rawText: unknown,
  options: SanitizePromptOptions = {}
): string {
  if (typeof rawText !== 'string' || !rawText) {
    return '';
  }

  const maxLength = options.maxLength ?? DEFAULT_MAX_PROMPT_LENGTH;
  let text = rawText;

  // 1. Redact secrets and tokens first
  text = redactSecrets(text);

  // 2. Suppress specific known absolute paths if provided
  const home = os.homedir();
  const knownPaths = [
    { path: options.worktreePath, replace: '[WORKTREE]' },
    { path: options.targetRepoPath, replace: '[REPO]' },
    { path: options.stateDir, replace: '[STATE_DIR]' },
    { path: options.allowedBaseDir, replace: '[ALLOWED_BASE]' },
    { path: home, replace: '~' },
  ];

  for (const { path: p, replace } of knownPaths) {
    if (p && typeof p === 'string' && p.trim().length > 1) {
      const normalized = p.trim().replace(/\\/g, '/');
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), replace);

      // Also match Windows-style backslashes if on Windows
      const winEscaped = p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (winEscaped !== escaped) {
        text = text.replace(new RegExp(winEscaped, 'g'), replace);
      }
    }
  }

  // 3. Suppress generic absolute paths
  // Unix absolute paths: /Users/..., /home/..., /private/..., /var/..., /tmp/..., /opt/..., /etc/..., /usr/...
  text = text.replace(
    /(?:file:\/\/)?(?:\/private)?\/(?:Users|home|root|var|tmp|opt|etc|usr|Volumes)\/[^\s'"`,;)<>\]}]+/g,
    '[PATH]'
  );

  // Windows absolute paths: C:\..., D:\...
  text = text.replace(/\b[a-zA-Z]:\\[^\s'"`,;)<>\]}]+/g, '[PATH]');

  // 4. Redact environment variable assignments (e.g., export FOO=bar, SECRET_KEY=123, API_TOKEN="abc")
  text = text.replace(
    /\b(?:export\s+)?([A-Z_][A-Z0-9_]{2,})\s*=\s*(["'][^"'\r\n]*["']|[^\s\r\n]+)/g,
    '$1=[REDACTED_ENV]'
  );

  // Redact live process.env values if present in prompt text
  try {
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value &&
        typeof value === 'string' &&
        value.length >= 6 &&
        !COMMON_ENV_IGNORABLE_VALUES.has(value.toLowerCase())
      ) {
        // Redact if the key indicates security or path or if exact value is present
        const isSuspiciousKey =
          /token|secret|key|pass|auth|cred|cookie|session|api|url|dir|path/i.test(key);
        if (isSuspiciousKey && text.includes(value)) {
          const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          text = text.replace(new RegExp(escapedVal, 'g'), '[REDACTED_ENV]');
        }
      }
    }
  } catch {
    // Ignore environment enumeration failures in restricted runtimes
  }

  // 5. Length bounding
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '\n... [TRUNCATED]';
  }

  return text;
}
