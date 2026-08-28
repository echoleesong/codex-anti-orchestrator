import { describe, expect, it, vi } from 'vitest';
import { MonitorAutoLauncher } from '../src/monitor/auto-launch.js';

describe('MCP monitor auto-launcher', () => {
  it('starts a loopback monitor once and opens its URL once for repeated MCP calls', async () => {
    const start = vi.fn(async ({ port }: { port?: number }) => ({
      host: '127.0.0.1',
      port: port || 4390,
      server: {} as never,
      close: async () => undefined,
    }));
    const openUrl = vi.fn(async () => undefined);
    const launcher = new MonitorAutoLauncher({ stateDir: '/safe/state', start, openUrl });

    await expect(launcher.ensureStarted()).resolves.toEqual({
      url: 'http://127.0.0.1:4390',
      opened: true,
    });
    await launcher.ensureStarted();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ stateDir: '/safe/state', host: '127.0.0.1', port: 4390 });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps the monitor loopback-only and falls through when the default port is occupied', async () => {
    const addressInUse = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    const start = vi
      .fn()
      .mockRejectedValueOnce(addressInUse)
      .mockResolvedValue({
        host: '127.0.0.1',
        port: 4391,
        server: {} as never,
        close: async () => undefined,
      });
    const launcher = new MonitorAutoLauncher({
      stateDir: '/safe/state',
      start,
      openUrl: async () => undefined,
    });

    await expect(launcher.ensureStarted()).resolves.toMatchObject({
      url: 'http://127.0.0.1:4391',
    });
    expect(start.mock.calls.map(([options]) => options.host)).toEqual(['127.0.0.1', '127.0.0.1']);
    expect(start.mock.calls.map(([options]) => options.port)).toEqual([4390, 4391]);
  });
});
