#!/usr/bin/env node
import { formatDoctorReport, runDoctor } from './doctor/doctor.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
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
  create --repo <path> --prompt <p>    Initialize task, validate cleanliness, create external worktree
  status [<taskId>] [--all]            Inspect status of a specific task or list all tasks
  cancel <taskId> [--reason <r>]       Cancel active task while preserving worktree
  resume <taskId> [--override]         Resume task from decision or failure state
  version, --version                   Show version information
  help, --help                         Show this help message

OPTIONS:
  --json, -j                           Output result as clean JSON
  --repo, -r <path>                    Target repository path (must reside in /Users/lisong/code)
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
