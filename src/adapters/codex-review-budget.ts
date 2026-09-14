import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { CodexReviewResult } from '../types.js';

const CACHE_VERSION = 1;
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
  reviewKey: string;
  headSha: string;
}

export interface CodexReviewBudgetStoreOptions {
  cacheFile?: string;
  maxCallsPerTask?: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
        (line) =>
          line && !line.startsWith('#') && !line.startsWith('^') && line.endsWith(` ${ref}`)
      );
    if (!match) return undefined;
    const sha = match.split(' ')[0];
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveWorktreeHeadSha(worktreePath: string): Promise<string | undefined> {
  const gitDir = await resolveGitDirectory(worktreePath);
  if (!gitDir) return undefined;

  try {
    const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;

    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch?.[1]) return undefined;
    const commonGitDir = await resolveCommonGitDirectory(gitDir);
    return resolveRef(commonGitDir, refMatch[1].trim());
  } catch {
    return undefined;
  }
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

  async identify(
    worktreePath: string,
    baseBranch: string,
    taskPrompt?: string
  ): Promise<ReviewIdentity | undefined> {
    const headSha = await resolveWorktreeHeadSha(worktreePath);
    if (!headSha) return undefined;

    const taskKey = hash(path.resolve(worktreePath));
    const reviewKey = hash(
      [String(CACHE_VERSION), baseBranch, headSha, taskPrompt?.trim() || ''].join('\0')
    );
    return { taskKey, reviewKey, headSha };
  }

  async getCached(identity: ReviewIdentity): Promise<CodexReviewResult | undefined> {
    const state = await this.load();
    return state.tasks[identity.taskKey]?.reviews[identity.reviewKey]?.result;
  }

  async reserveCall(identity: ReviewIdentity): Promise<{
    allowed: boolean;
    calls: number;
    maxCalls: number;
  }> {
    const state = await this.load();
    const task = state.tasks[identity.taskKey] || { calls: 0, reviews: {} };
    if (task.calls >= this.maxCallsPerTask) {
      return { allowed: false, calls: task.calls, maxCalls: this.maxCallsPerTask };
    }

    task.calls += 1;
    state.tasks[identity.taskKey] = task;
    await this.save(state);
    return { allowed: true, calls: task.calls, maxCalls: this.maxCallsPerTask };
  }

  async store(identity: ReviewIdentity, result: CodexReviewResult): Promise<void> {
    if (!result.parsedCleanly) return;

    const state = await this.load();
    const task = state.tasks[identity.taskKey] || { calls: 0, reviews: {} };
    task.reviews[identity.reviewKey] = {
      savedAt: new Date().toISOString(),
      result,
    };
    state.tasks[identity.taskKey] = task;
    await this.save(state);
  }

  private async load(): Promise<BudgetState> {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as BudgetState;
      if (parsed.version !== CACHE_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
        return { version: CACHE_VERSION, tasks: {} };
      }
      return parsed;
    } catch {
      return { version: CACHE_VERSION, tasks: {} };
    }
  }

  private async save(state: BudgetState): Promise<void> {
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tempFile = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tempFile, this.cacheFile);
  }
}
