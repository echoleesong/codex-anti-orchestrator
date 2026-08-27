import { execFile } from 'node:child_process';
import type { CommandExecutor, ExecOutput } from '../types.js';

export const defaultExecutor: CommandExecutor = (
  file: string,
  args: string[],
  options = {}
): Promise<ExecOutput> => {
  const { cwd = process.cwd(), timeoutMs = 10000, env = process.env } = options;

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({
          exitCode,
          stdout: stdout?.toString() || '',
          stderr: stderr?.toString() || '',
          error: error || undefined,
        });
      }
    );
  });
};
