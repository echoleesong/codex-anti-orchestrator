import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { CodexReviewResult } from '../types.js';

const CACHE_VERSION = 1;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;
export const DEFAULT_MAX_CODEX_CALLS_PER_TASK = 3;

interface CachedReviewEntry {
  savedAt: string;
  result: CodexReviewResult;
}

interface TaskBudgetEntry {
  calls: number;
  reviews: Record<string, CachedReviewEntry>;
}

interface BudgetState {
  version: number;
  tasks: Record<string, TaskBudgetEntry>;
}

export interface ReviewIdentity {
  taskKey: string;
  reviewKey?: string;
  headSha?: string;
  baseSha?: string;
  cacheable: boolean;
}

export interface CodexReviewBudgetStoreOptions {
  cacheFile?: string;
  maxCallsPerTask?: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function resolveGitDirectory(worktreePath: string): Promise<string | undefined> {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    if (!info.isFile()) return undefined;

    const pointer = await readFile(dotGit, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match?.[1]) return undefined;
    return path.resolve(worktreePath, match[1].trim());
  } catch {
    return undefined;
  }
}

async function resolveCommonGitDirectory(gitDir: string): Promise<string> {
  try {
    const commonDir = (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  } catch {
    return gitDir;
  }
}

async function resolveRef(commonGitDir: string, ref: string): Promise<string | undefined> {
  try {
    const direct = (await readFile(path.join(commonGitDir, ref), 'utf8')).trim();
    if (/^[0-9a-f]{40,64}$/i.test(direct)) return direct;
  } catch {
    // Fall through to packed-refs.
  }

  try {
    const packedRefs = await readFile(path.join(commonGitDir, 'packed-refs'), 'utf8');
    const match = packedRefs
      .split('\n')
      .map((line) => line.trim())
      .find(
        (line) => line && !line.startsWith('#') && !line.startsWith('^') && line.endsWith(` ${ref}`)
      );
    if (!match) return undefined;
    const sha = match.split(' ')[0];
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function resolveRepositoryContext(worktreePath: string): Promise<
  | {
      gitDir: string;
      commonGitDir: string;
    }
  | undefined
> {
  const gitDir = await resolveGitDirectory(worktreePath);
  if (!gitDir) return undefined;
  return {
    gitDir,
    commonGitDir: await resolveCommonGitDirectory(gitDir),
  };
}

export async function resolveWorktreeHeadSha(worktreePath: string): Promise<string | undefined> {
  const context = await resolveRepositoryContext(worktreePath);
  if (!context) return undefined;

  try {
    const head = (await readFile(path.join(context.gitDir, 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;

    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch?.[1]) return undefined;
    return resolveRef(context.commonGitDir, refMatch[1].trim());
  } catch {
    return undefined;
  }
}

export async function resolveWorktreeRefSha(
  worktreePath: string,
  refOrSha: string
): Promise<string | undefined> {
  const value = refOrSha.trim();
  if (/^[0-9a-f]{40,64}$/i.test(value)) return value;

  const context = await resolveRepositoryContext(worktreePath);
  if (!context) return undefined;

  const candidates = value.startsWith('refs/')
    ? [value]
    : value.startsWith('origin/')
      ? [`refs/remotes/${value}`]
      : [`refs/heads/${value}`, `refs/remotes/origin/${value}`, `refs/tags/${value}`];

  for (const candidate of candidates) {
    const resolved = await resolveRef(context.commonGitDir, candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

export class CodexReviewBudgetStore {
  private readonly cacheFile: string;
  private readonly maxCallsPerTask: number;

  constructor(options: CodexReviewBudgetStoreOptions = {}) {
    this.cacheFile =
      options.cacheFile ||
      path.join(homedir(), '.codex-anti-orchestrator', 'codex-review-cache-v1.json');
    this.maxCallsPerTask = Math.max(1, options.maxCallsPerTask ?? DEFAULT_MAX_CODEX_CALLS_PER_TASK);
  }

  getTaskKey(worktreePath: string): string {
    return hash(path.resolve(worktreePath));
  }

  async identify(
    worktreePath: string,
    baseBranch: string,
    taskPrompt?: string
  ): Promise<ReviewIdentity> {
    const taskKey = this.getTaskKey(worktreePath);
    const [headSha, baseSha] = await Promise.all([
      resolveWorktreeHeadSha(worktreePath),
      resolveWorktreeRefSha(worktreePath, baseBranch),
    ]);

    if (!headSha || !baseSha) {
      return { taskKey, headSha, baseSha, cacheable: false };
    }

    const reviewKey = hash(
      [String(CACHE_VERSION), baseSha, headSha, taskPrompt?.trim() || ''].join('\0')
    );
    return { taskKey, reviewKey, headSha, baseSha, cacheable: true };
  }

  async getCached(identity: ReviewIdentity): Promise<CodexReviewResult | undefined> {
    if (!identity.cacheable || !identity.reviewKey) return undefined;
    const state = await this.load();
    return state.tasks[identity.taskKey]?.reviews[identity.reviewKey]?.result;
  }

  async reserveCall(task: string | ReviewIdentity): Promise<{
    allowed: boolean;
    calls: number;
    maxCalls: number;
  }> {
    const taskKey = typeof task === 'string' ? task : task.taskKey;
    return this.withWriteLock(async () => {
      const state = await this.load();
      const taskBudget = state.tasks[taskKey] || { calls: 0, reviews: {} };
      if (taskBudget.calls >= this.maxCallsPerTask) {
        return {
          allowed: false,
          calls: taskBudget.calls,
          maxCalls: this.maxCallsPerTask,
        };
      }

      taskBudget.calls += 1;
      state.tasks[taskKey] = taskBudget;
      await this.save(state);
      return {
        allowed: true,
        calls: taskBudget.calls,
        maxCalls: this.maxCallsPerTask,
      };
    });
  }

  async store(identity: ReviewIdentity, result: CodexReviewResult): Promise<void> {
    if (!identity.cacheable || !identity.reviewKey || !result.parsedCleanly) return;

    await this.withWriteLock(async () => {
      const state = await this.load();
      const task = state.tasks[identity.taskKey] || { calls: 0, reviews: {} };
      task.reviews[identity.reviewKey!] = {
        savedAt: new Date().toISOString(),
        result,
      };
      state.tasks[identity.taskKey] = task;
      await this.save(state);
    });
  }

  private async load(): Promise<BudgetState> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFile, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { version: CACHE_VERSION, tasks: {} };
      }
      throw new Error(`Unable to read Codex review budget state: ${String(error)}`);
    }

    let parsed: BudgetState;
    try {
      parsed = JSON.parse(raw) as BudgetState;
    } catch (error) {
      throw new Error(
        `Codex review budget state is malformed; refusing to reset quota: ${String(error)}`
      );
    }

    if (parsed.version !== CACHE_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
      throw new Error('Codex review budget state is invalid; refusing to reset quota.');
    }
    return parsed;
  }

  private async save(state: BudgetState): Promise<void> {
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tempFile = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tempFile, this.cacheFile);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDir = `${this.cacheFile}.lock`;
    await mkdir(path.dirname(this.cacheFile), { recursive: true });

    let acquired = false;
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;

        try {
          const lockInfo = await stat(lockDir);
          if (Date.now() - lockInfo.mtimeMs > STALE_LOCK_MS) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if (errorCode(lockError) !== 'ENOENT') throw lockError;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      }
    }

    if (!acquired) {
      throw new Error(
        'Unable to acquire Codex review budget lock; refusing to spend untracked quota.'
      );
    }

    try {
      return await operation();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}
