import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMonitorServer } from './server.js';
import type { MonitorServerHandle } from './server.js';

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 4390;
const MAX_PORT_ATTEMPTS = 10;

export interface MonitorLaunchResult {
  url: string;
  opened: boolean;
}

export interface MonitorAutoLauncherOptions {
  stateDir: string;
  start?: typeof startMonitorServer;
  openUrl?: (url: string) => Promise<void>;
}

/**
 * Starts exactly one localhost monitor for an MCP server process and opens it once.
 * A port collision falls through to a nearby loopback-only port rather than exposing a LAN host.
 */
export class MonitorAutoLauncher {
  private readonly stateDir: string;
  private readonly start: typeof startMonitorServer;
  private readonly openUrl: (url: string) => Promise<void>;
  private launchPromise?: Promise<MonitorLaunchResult>;
  private handle?: MonitorServerHandle;

  constructor(options: MonitorAutoLauncherOptions) {
    this.stateDir = options.stateDir;
    this.start = options.start || startMonitorServer;
    this.openUrl = options.openUrl || openLocalUrl;
  }

  async ensureStarted(): Promise<MonitorLaunchResult> {
    this.launchPromise ||= this.launch();
    return this.launchPromise;
  }

  getHandle(): MonitorServerHandle | undefined {
    return this.handle;
  }

  private async launch(): Promise<MonitorLaunchResult> {
    let lastError: unknown;
    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      try {
        this.handle = await this.start({
          stateDir: this.stateDir,
          host: '127.0.0.1',
          port: DEFAULT_PORT + offset,
        });
        const url = `http://${this.handle.host}:${this.handle.port}`;
        try {
          await this.openUrl(url);
          return { url, opened: true };
        } catch {
          // The monitor is useful even when the operating system refuses to open a browser.
          return { url, opened: false };
        }
      } catch (error) {
        lastError = error;
        if (!isAddressInUse(error)) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Could not allocate a loopback port for the local monitor.');
  }
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EADDRINUSE'
  );
}

async function openLocalUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
  } else if (process.platform === 'linux') {
    await execFileAsync('xdg-open', [url]);
  } else if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url]);
  }
}
