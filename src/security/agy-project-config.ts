import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface JsonObject {
  [key: string]: unknown;
}

export interface AgyProjectConfigResult {
  projectId: string;
  configPath: string;
  worktreePath: string;
}

const SAFE_COMMAND_ALLOW_RULES = [
  'command(pwd)',
  'command(ls)',
  'command(rg)',
  'command(find)',
  'command(sed)',
  'command(head)',
  'command(tail)',
  'command(wc)',
  'command(git status)',
  'command(git status --short)',
  'command(git diff)',
  'command(git diff --check)',
  'command(git log)',
  'command(git branch)',
  'command(git rev-parse)',
  'command(git show)',
  'command(pnpm install --frozen-lockfile)',
  'command(pnpm build)',
  'command(pnpm lint)',
  'command(pnpm typecheck)',
  'command(pnpm test)',
  'command(pnpm format:check)',
  'command(pnpm db:generate)',
  'command(npm ci)',
  'command(npm run build)',
  'command(npm run lint)',
  'command(npm run typecheck)',
  'command(npm test)',
  'command(npm run format:check)',
] as const;

const DANGEROUS_COMMAND_DENY_RULES = [
  'command(sudo)',
  'command(rm)',
  'command(rm -rf)',
  'command(git reset)',
  'command(git reset --hard)',
  'command(git clean)',
  'command(git push)',
  'command(git push --force)',
  'command(git push --force-with-lease)',
  'command(git merge)',
  'command(git rebase)',
  'command(gh)',
  'command(gh pr merge)',
  'command(gh workflow)',
  'command(gh release)',
  'command(docker)',
  'command(docker compose)',
  'command(kubectl)',
  'command(ssh)',
  'command(scp)',
  'command(curl)',
  'command(wget)',
  'command(npm publish)',
  'command(pnpm publish)',
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deterministicProjectId(canonicalWorktree: string): string {
  const hex = createHash('sha256')
    .update(`codex-anti-orchestrator\0${canonicalWorktree}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex
    .slice(12, 16)
    .join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function readExistingConfig(configPath: string): JsonObject {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing unsafe Antigravity project config path: ${configPath}`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isJsonObject(parsed)) {
    throw new Error(`Antigravity project config must contain a JSON object: ${configPath}`);
  }
  return parsed;
}

/** Creates path-scoped Antigravity grants without changing global permissions. */
export function prepareAgyProjectConfig(
  worktreePath: string,
  configRoot = path.join(os.homedir(), '.gemini', 'config')
): AgyProjectConfigResult {
  if (!worktreePath || /[\r\n()]/.test(worktreePath)) {
    throw new Error(
      'Worktree path cannot be represented safely in an Antigravity permission rule.'
    );
  }
  const canonicalWorktree = fs.realpathSync(worktreePath);
  if (!fs.statSync(canonicalWorktree).isDirectory()) {
    throw new Error(`Worktree path is not a directory: ${canonicalWorktree}`);
  }

  const projectsDir = path.join(path.resolve(configRoot), 'projects');
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  const projectId = deterministicProjectId(canonicalWorktree);
  const configPath = path.join(projectsDir, `${projectId}.json`);
  const existing = readExistingConfig(configPath);
  const permissionContainer = isJsonObject(existing.permissionGrants)
    ? existing.permissionGrants
    : {};
  const existingGrants = isJsonObject(permissionContainer.permissionGrants)
    ? permissionContainer.permissionGrants
    : {};
  const nextConfig: JsonObject = {
    ...existing,
    id: projectId,
    name: `codex-anti-${path.basename(canonicalWorktree)}`.slice(0, 120),
    projectResources: {
      resources: [
        {
          gitFolder: {
            folderUri: pathToFileURL(canonicalWorktree).href,
            allowWrite: true,
          },
        },
      ],
    },
    permissionGrants: {
      ...permissionContainer,
      permissionGrants: {
        ...existingGrants,
        allow: [
          `read_file(${canonicalWorktree})`,
          `write_file(${canonicalWorktree})`,
          ...SAFE_COMMAND_ALLOW_RULES,
        ],
        deny: [...DANGEROUS_COMMAND_DENY_RULES],
      },
    },
    updatedAt: new Date().toISOString(),
  };

  const tempPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return { projectId, configPath, worktreePath: canonicalWorktree };
}
