#!/usr/bin/env node
import { formatDoctorReport, runDoctor } from './doctor/doctor.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'doctor': {
      const isJson = args.includes('--json');
      const report = await runDoctor();

      if (isJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }

      if (report.hasErrors) {
        process.exit(1);
      }
      process.exit(0);
      break;
    }

    case '--version':
    case '-v':
    case 'version': {
      console.log('codex-anti-orchestrator v0.1.0');
      process.exit(0);
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default: {
      console.log(
        `
codex-anti-orchestrator - Local Orchestrator for Codex Review & Antigravity Development

USAGE:
  orchestrator <command> [options]

COMMANDS:
  doctor              Run read-only prerequisite and environment diagnostics
  version, --version  Show version information
  help, --help        Show this help message

OPTIONS for 'doctor':
  --json              Output diagnostics as JSON
      `.trim()
      );
      process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal orchestrator error:', err);
  process.exit(1);
});
