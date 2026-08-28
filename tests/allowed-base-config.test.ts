import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAllowedBaseConfig,
  normalizeAllowedBaseDir,
  saveAllowedBaseConfig,
  suggestAllowedBaseDir,
} from '../src/security/allowed-base-config.js';

describe('confirmed allowed base configuration', () => {
  let tempDir: string;
  let stateDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-base-test-'));
    stateDir = path.join(tempDir, 'state');
    projectsDir = path.join(tempDir, 'projects');
    fs.mkdirSync(path.join(projectsDir, 'app'), { recursive: true });
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('persists and loads a confirmed directory using its canonical path', () => {
    const saved = saveAllowedBaseConfig(stateDir, projectsDir);
    expect(saved.allowedBaseDir).toBe(fs.realpathSync(projectsDir));
    expect(loadAllowedBaseConfig(stateDir)).toMatchObject({ allowedBaseDir: saved.allowedBaseDir });
    expect(suggestAllowedBaseDir(path.join(projectsDir, 'app'))).toBe(saved.allowedBaseDir);
  });

  it('rejects broad, relative, absent, and non-directory approval targets', () => {
    expect(() => normalizeAllowedBaseDir('relative/projects')).toThrow(/absolute/);
    expect(() => normalizeAllowedBaseDir(path.join(tempDir, 'absent'))).toThrow(/does not exist/);
    const file = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    expect(() => normalizeAllowedBaseDir(file)).toThrow(/not a directory/);
    expect(() => normalizeAllowedBaseDir(path.parse(tempDir).root)).toThrow(/filesystem root/);
    expect(() => normalizeAllowedBaseDir(os.homedir())).toThrow(/entire home directory/);
  });
});
