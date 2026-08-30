import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_FILE_NAME = 'allowed-base.json';

export interface AllowedBaseConfig {
  version: 1;
  allowedBaseDir: string;
  confirmedAt: string;
}

export function getAllowedBaseConfigPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), CONFIG_FILE_NAME);
}

export function normalizeAllowedBaseDir(candidate: string): string {
  if (!candidate || typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('Allowed base directory must be a non-empty absolute path.');
  }
  const trimmed = candidate.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Allowed base directory must be an absolute path.');
  }
  if (!fs.existsSync(trimmed)) {
    throw new Error(`Allowed base directory does not exist: ${trimmed}`);
  }
  const resolved = fs.realpathSync(trimmed);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Allowed base path is not a directory: ${resolved}`);
  }
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error(
      'Allowed base directory cannot be the filesystem root or the entire home directory.'
    );
  }
  return resolved;
}

export function suggestAllowedBaseDir(targetRepoPath: string): string {
  const parent = path.dirname(path.resolve(targetRepoPath));
  return normalizeAllowedBaseDir(parent);
}

export function loadAllowedBaseConfig(stateDir: string): AllowedBaseConfig | undefined {
  const configPath = getAllowedBaseConfigPath(stateDir);
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<AllowedBaseConfig>;
    if (parsed.version !== 1 || typeof parsed.allowedBaseDir !== 'string') return undefined;
    return {
      version: 1,
      allowedBaseDir: normalizeAllowedBaseDir(parsed.allowedBaseDir),
      confirmedAt: typeof parsed.confirmedAt === 'string' ? parsed.confirmedAt : '',
    };
  } catch {
    return undefined;
  }
}

export function saveAllowedBaseConfig(stateDir: string, candidate: string): AllowedBaseConfig {
  const allowedBaseDir = normalizeAllowedBaseDir(candidate);
  const config: AllowedBaseConfig = {
    version: 1,
    allowedBaseDir,
    confirmedAt: new Date().toISOString(),
  };
  const configPath = getAllowedBaseConfigPath(stateDir);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tempPath, configPath);
  return config;
}
