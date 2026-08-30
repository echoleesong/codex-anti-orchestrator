#!/usr/bin/env node
import { formatDoctorReport, runDoctor } from './doctor/doctor.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { startMonitorServer } from './monitor/server.js';
import type { TaskRecord } from './types.js';

function parseArgValue(args: string[], flag: string, shortFlag?: string): string | undefined {
  const idx = args.findIndex((a) => a === flag || (shortFlag && a === shortFlag));
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
    return args[idx + 1];
  }
  const prefixMatch = args.find((a) => a.startsWith(`${flag}=`));
  if (prefixMatch) {
    return prefixMatch.slice(flag.length + 1);
  }
  return undefined;
}

function formatTaskSummary(task: TaskRecord): string {
  const lines: string[] = [];
  lines.push('======================================================');
  lines.push(`Task ID      : ${task.id}`);
  lines.push(`State        : ${task.state}`);
  lines.push(`Target Repo  : ${task.targetRepoPath}`);
  lines.push(`Base Branch  : ${task.baseBranch}`);
  lines.push(`Task Branch  : ${task.taskBranch}`);
  lines.push(`Worktree Path: ${task.worktreePath}`);
  lines.push(`Created At   : ${task.createdAt}`);
  lines.push(`Updated At   : ${task.updatedAt}`);
  lines.push(`Prompt       : ${task.prompt}`);
  lines.push('------------------------------------------------------');
  lines.push(
    `Review Cycles: ${task.diagnostics.reviewCycles} / ${task.diagnostics.maxReviewCycles}`
  );
  lines.push(`Worktree Preserved: ${task.diagnostics.worktreePreserved ? 'YES' : 'NO'}`);

  if (task.diagnostics.lastError) {
    lines.push(`Last Error   : ${task.diagnostics.lastError}`);
  }
  if (task.diagnostics.resumeInstructions) {
    lines.push(`Resume Hint  : ${task.diagnostics.resumeInstructions}`);
  }

  if (task.transitions.length > 0) {
    lines.push('------------------------------------------------------');
    lines.push('State History:');
    for (const t of task.transitions) {
      const reasonStr = t.reason ? ` (${t.reason})` : '';
      lines.push(`  - [${t.timestamp}] ${t.from} -> ${t.to}${reasonStr}`);
    }
  }
  lines.push('======================================================');
  return lines.join('\n');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const isJson = rawArgs.includes('--json') || rawArgs.includes('-j');
  const nonFlagArgs = rawArgs.filter((arg) => !arg.startsWith('-'));
  const command =
    nonFlagArgs[0] || (rawArgs.some((a) => a === '-v' || a === '--version') ? 'version' : 'help');

  const orchestrator = new Orchestrator();

  switch (command) {
    case 'doctor': {
      const report = await runDoctor();
      if (isJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }
      process.exit(report.hasErrors ? 1 : 0);
      break;
    }

    case 'create': {
      const repoPath = parseArgValue(rawArgs, '--repo', '-r');
      const prompt = parseArgValue(rawArgs, '--prompt', '-p');
      const baseBranch = parseArgValue(rawArgs, '--base', '-b');

      if (!repoPath || !prompt) {
        process.stderr.write(
          'Error: Missing required arguments for create. Usage: orchestrator create --repo <path> --prompt <prompt> [--base <branch>]\n'
        );
        process.exit(1);
      }

      try {
        const task = await orchestrator.createTask({
          repoPath,
          prompt,
          baseBranch,
        });

        if (isJson) {
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } else {
          process.stdout.write('✓ Task created and external worktree prepared successfully!\n\n');
          process.stdout.write(`${formatTaskSummary(task)}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to create task: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'configure': {
      const allowedBaseDir = parseArgValue(rawArgs, '--allowed-base');
      const confirmed = rawArgs.includes('--confirm');
      if (!allowedBaseDir || !confirmed) {
        process.stderr.write(
          'Error: Usage: orchestrator configure --allowed-base <absolute-directory> --confirm\n'
        );
        process.exit(1);
      }
      try {
        const config = orchestrator.configureAllowedBaseDir(allowedBaseDir);
        if (isJson) {
          process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
        } else {
          process.stdout.write(`✓ Allowed repository root confirmed: ${config.allowedBaseDir}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to configure allowed repository root: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const taskId = nonFlagArgs[1] || parseArgValue(rawArgs, '--id');
      const showAll = rawArgs.includes('--all') || rawArgs.includes('-a');

      try {
        if (showAll || !taskId) {
          const tasks = await orchestrator.listTasks();
          if (isJson) {
            process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
          } else {
            if (tasks.length === 0) {
              process.stdout.write('No orchestrated tasks found.\n');
            } else {
              process.stdout.write(`Found ${tasks.length} task(s):\n\n`);
              for (const task of tasks) {
                process.stdout.write(`${formatTaskSummary(task)}\n\n`);
              }
            }
          }
        } else {
          const task = await orchestrator.getTask(taskId);
          if (isJson) {
            process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
          } else {
            process.stdout.write(`${formatTaskSummary(task)}\n`);
          }
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to retrieve status: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'cancel': {
      const taskId = nonFlagArgs[1] || parseArgValue(rawArgs, '--id');
      const reason = parseArgValue(rawArgs, '--reason') || 'Cancelled by user via CLI';

      if (!taskId) {
        process.stderr.write(
          'Error: Task ID required. Usage: orchestrator cancel <taskId> [--reason <text>]\n'
        );
        process.exit(1);
      }

      try {
        const task = await orchestrator.cancelTask(taskId, reason);
        if (isJson) {
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ Task ${taskId} cancelled (worktree preserved at ${task.worktreePath})\n\n`
          );
          process.stdout.write(`${formatTaskSummary(task)}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to cancel task: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'resume': {
      const taskId = nonFlagArgs[1] || parseArgValue(rawArgs, '--id');
      const override = rawArgs.includes('--override');
      const guidance = parseArgValue(rawArgs, '--guidance', '-g');

      if (!taskId) {
        process.stderr.write(
          'Error: Task ID required. Usage: orchestrator resume <taskId> [--override] [--guidance <text>]\n'
        );
        process.exit(1);
      }

      try {
        const task = await orchestrator.resumeTask(taskId, {
          override,
          guidance,
        });

        if (isJson) {
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } else {
          process.stdout.write(`✓ Task ${taskId} resumed (current state: ${task.state})\n\n`);
          process.stdout.write(`${formatTaskSummary(task)}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to resume task: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const taskId = nonFlagArgs[1] || parseArgValue(rawArgs, '--id');
      if (!taskId) {
        process.stderr.write('Error: Task ID required. Usage: orchestrator run <taskId>\n');
        process.exit(1);
      }

      try {
        const task = await orchestrator.runTaskLoop(taskId);
        if (isJson) {
          process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
        } else {
          process.stdout.write(`✓ Task loop finished (current state: ${task.state})\n\n`);
          process.stdout.write(`${formatTaskSummary(task)}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Failed to run task loop: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'monitor': {
      const rawPort = parseArgValue(rawArgs, '--port');
      const port = rawPort ? Number.parseInt(rawPort, 10) : 4390;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write('Error: --port must be an integer between 1 and 65535.\n');
        process.exit(1);
      }
      try {
        const monitor = await startMonitorServer({
          stateDir: orchestrator.getStateDir(),
          port,
        });
        const url = `http://${monitor.host}:${monitor.port}`;
        if (isJson) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, url, host: monitor.host, port: monitor.port })}\n`
          );
        } else {
          process.stdout.write(`Local monitor listening at ${url}\nPress Ctrl+C to stop.\n`);
        }
        const stop = () => {
          void monitor.close().finally(() => process.exit(0));
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } catch (err) {
        process.stderr.write(
          `Failed to start monitor: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
      break;
    }

    case 'version': {
      process.stdout.write('codex-anti-orchestrator v0.1.0\n');
      process.exit(0);
      break;
    }

    case 'help':
    default: {
      const helpText = `
codex-anti-orchestrator - Local Orchestrator for Codex Review & Antigravity Development

USAGE:
  orchestrator <command> [options]

COMMANDS:
  doctor                               Run read-only prerequisite and environment diagnostics
  configure --allowed-base <path> --confirm
                                       Confirm the local directory tree permitted for target repositories
  create --repo <path> --prompt <p>    Initialize task, validate cleanliness, create external worktree
  run <taskId>                         Execute the development, PR, and review state loop
  monitor [--port <port>]              Serve the local read-only task monitor on localhost
  status [<taskId>] [--all]            Inspect status of a specific task or list all tasks
  cancel <taskId> [--reason <r>]       Cancel active task while preserving worktree
  resume <taskId> [--override]         Resume task from decision or failure state
  version, --version                   Show version information
  help, --help                         Show this help message

OPTIONS:
  --json, -j                           Output result as clean JSON
  --repo, -r <path>                    Target repository path (must reside in the confirmed allowed directory)
  --prompt, -p <text>                  Development task prompt / instructions
  --base, -b <branch>                  Base branch for worktree (defaults to HEAD branch)
  --override                           Acknowledge and override review warnings in NEEDS_USER_DECISION
  --guidance, -g <text>                Provide additional instructions when retrying fix loop
      `.trim();
      process.stdout.write(`${helpText}\n`);
      process.exit(command === 'help' ? 0 : 1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(
    `Fatal orchestrator error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
