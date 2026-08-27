#!/usr/bin/env node
import { formatDoctorReport, runDoctor } from './doctor/doctor.js';

async function main() {
  const rawArgs = process.argv.slice(2);
  const isJson = rawArgs.includes('--json') || rawArgs.includes('-j');
  const nonFlagArgs = rawArgs.filter((arg) => !arg.startsWith('-'));
  const command =
    nonFlagArgs[0] || (rawArgs.some((a) => a === '-v' || a === '--version') ? 'version' : 'help');

  switch (command) {
    case 'doctor': {
      const report = await runDoctor();

      if (isJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }

      if (report.hasErrors) {
        process.exit(1);
      }
      process.exit(0);
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
  doctor              Run read-only prerequisite and environment diagnostics
  version, --version  Show version information
  help, --help        Show this help message

OPTIONS for 'doctor':
  --json, -j          Output diagnostics as clean JSON
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
