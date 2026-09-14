import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAgyProjectConfig } from '../src/security/agy-project-config.js';

describe('prepareAgyProjectConfig', () => {
  let tempDir: string;
  let worktree: string;
  let configRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-config-'));
    worktree = path.join(tempDir, 'worktree');
    configRoot = path.join(tempDir, 'config');
    fs.mkdirSync(worktree);
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('creates deterministic path-scoped grants without broad wildcard access', () => {
    const first = prepareAgyProjectConfig(worktree, configRoot);
    const second = prepareAgyProjectConfig(worktree, configRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));

    expect(second.projectId).toBe(first.projectId);
    expect(config.projectResources.resources).toEqual([
      {
        gitFolder: {
          folderUri: expect.stringMatching(/^file:\/\//),
          allowWrite: true,
        },
      },
    ]);
    expect(config.permissionGrants.permissionGrants.allow).toContain(
      `read_file(${fs.realpathSync(worktree)})`
    );
    expect(config.permissionGrants.permissionGrants.allow).toContain(
      `write_file(${fs.realpathSync(worktree)})`
    );
    expect(config.permissionGrants.permissionGrants.allow).not.toContain('command(*)');
    expect(
      config.permissionGrants.permissionGrants.allow.some((rule: string) =>
        rule.startsWith('unsandboxed(')
      )
    ).toBe(false);
    expect(config.permissionGrants.permissionGrants.deny).toContain('command(git push)');
  });

  it('preserves unknown project fields while replacing stale generated grants', () => {
    const initial = prepareAgyProjectConfig(worktree, configRoot);
    const config = JSON.parse(fs.readFileSync(initial.configPath, 'utf8'));
    config.futureField = { keep: true };
    config.permissionGrants.futureGrantField = 'keep';
    config.permissionGrants.permissionGrants.allow = ['command(old)'];
    fs.writeFileSync(initial.configPath, JSON.stringify(config));

    prepareAgyProjectConfig(worktree, configRoot);
    const updated = JSON.parse(fs.readFileSync(initial.configPath, 'utf8'));
    expect(updated.futureField).toEqual({ keep: true });
    expect(updated.permissionGrants.futureGrantField).toBe('keep');
    expect(updated.permissionGrants.permissionGrants.allow).not.toContain('command(old)');
  });

  it('rejects permission-rule injection and symlink config targets', () => {
    const unsafeWorktree = path.join(tempDir, 'bad)\ncommand(*)');
    expect(() => prepareAgyProjectConfig(unsafeWorktree, configRoot)).toThrow(
      /cannot be represented safely/
    );

    const prepared = prepareAgyProjectConfig(worktree, configRoot);
    fs.rmSync(prepared.configPath);
    fs.symlinkSync(path.join(tempDir, 'victim.json'), prepared.configPath);
    expect(() => prepareAgyProjectConfig(worktree, configRoot)).toThrow(/unsafe.*config path/i);
  });
});
