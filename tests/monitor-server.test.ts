import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMonitorServer } from '../src/monitor/server.js';
import { saveTaskState } from '../src/state/state-machine.js';
import type { TaskRecord } from '../src/types.js';

function request(
  port: number,
  pathname: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode || 0, headers: response.headers, body })
      );
    });
    req.on('error', reject);
  });
}

describe('local monitor HTTP server', () => {
  let stateDir: string;
  let task: TaskRecord;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
    task = {
      id: 'task-123-monitor-abcdef',
      targetRepoPath: '/Users/example/projects/example',
      baseBranch: 'main',
      taskBranch: 'anti/task-123-monitor-abcdef',
      worktreePath: '/safe/external/worktree',
      state: 'CODEX_REVIEWING',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      prompt: 'Use token=supersecretvalue for an example only',
      transitions: [],
      events: [
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          source: 'ANTI',
          message: 'Development completed',
          detail: 'Bearer abcdefghijklmno',
        },
      ],
      diagnostics: {
        reviewCycles: 0,
        maxReviewCycles: 3,
        resumePossible: false,
        worktreePreserved: true,
        humanVerificationChecklist: ['Open the changed screen and verify the new state.'],
        liveVerification: {
          status: 'PASSED',
          command: 'npm run dev -- --host 127.0.0.1',
          url: 'javascript:alert(1)',
          checks: ['Screen rendered with token=supersecretvalue'],
          summary: 'Bearer abcdefghijklmno',
          parsedCleanly: true,
        },
      },
      metadata: { prUrl: 'javascript:alert(1)' },
    };
    await saveTaskState(stateDir, task);
  });

  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it('serves only local read-only task data with security headers and redaction', async () => {
    const monitor = await startMonitorServer({ stateDir, port: 0 });
    try {
      const list = await request(monitor.port, '/api/tasks');
      expect(list.status).toBe(200);
      expect(list.headers['content-security-policy']).toContain("default-src 'none'");
      expect(JSON.parse(list.body).tasks[0].id).toBe(task.id);
      expect((await request(monitor.port, '/favicon.ico')).status).toBe(204);

      const detail = await request(monitor.port, `/api/tasks/${task.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toContain('[REDACTED_SECRET]');
      expect(detail.body).toContain('[REDACTED_BEARER_TOKEN]');
      expect(detail.body).not.toContain('supersecretvalue');
      expect(detail.body).not.toContain('abcdefghijklmno');
      expect(detail.body).not.toContain('javascript:');
      expect(detail.body).toContain('Open the changed screen');
      expect(detail.body).not.toContain('supersecretvalue');
    } finally {
      await monitor.close();
    }
  });

  it('rejects path traversal and exposes no mutation endpoint', async () => {
    const monitor = await startMonitorServer({ stateDir, port: 0 });
    try {
      expect((await request(monitor.port, '/api/tasks/%2e%2e%2fstate.json')).status).toBe(400);
      expect((await request(monitor.port, '/api/tasks/%')).status).toBe(400);
      expect((await request(monitor.port, '/api/tasks/..')).status).toBe(404);
      expect((await request(monitor.port, '/api/tasks/task-123-monitor-abcdef/extra')).status).toBe(
        404
      );
      expect((await request(monitor.port, '/api/merge')).status).toBe(404);
    } finally {
      await monitor.close();
    }
  });

  it('refuses non-local listen hosts', async () => {
    await expect(startMonitorServer({ stateDir, host: '0.0.0.0', port: 0 })).rejects.toThrow(
      /localhost/
    );
  });
});
