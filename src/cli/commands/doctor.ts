/**
 * PROWL-026 / P6-003 — `prowl doctor`: check that the environment is set up to
 * run Prowl hunts, and (`--fix`) attempt the two safe auto-repairs.
 *
 * All the logic and every side effect live behind the injectable seam in
 * `../../doctor/checks.js`; this file only wires the command up and renders the
 * results. Output is color-coded (green ✓ / red ✗ / yellow ⚠ / gray ○) with a
 * one-line summary; the exit code is 1 when any check failed (warnings are OK).
 */
import chalk from "chalk";
import { Command } from "commander";
import {
  runDoctor,
  defaultDoctorDeps,
  type CheckResult,
  type CheckStatus,
  type DoctorDeps,
  type DoctorReport
} from "../../doctor/checks.js";

function symbol(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return chalk.green("✓"); // ✓
    case "fail":
      return chalk.red("✗"); // ✗
    case "warn":
      return chalk.yellow("⚠"); // ⚠
    case "skip":
      return chalk.gray("○"); // ○
  }
}

function renderResult(result: CheckResult): void {
  console.log(`  ${symbol(result.status)} ${chalk.bold(result.name)}`);
  console.log(`      ${chalk.gray(result.message)}`);
}

function renderReport(report: DoctorReport, fixRequested: boolean): void {
  console.log(chalk.bold("\nprowl doctor\n"));

  for (const result of report.results) {
    renderResult(result);
  }

  if (fixRequested) {
    console.log("");
    if (report.fixes.length === 0) {
      console.log(chalk.gray("  No auto-fixable issues to repair."));
    } else {
      console.log(chalk.bold("  Attempted fixes:"));
      for (const fix of report.fixes) {
        if (fix.error) {
          console.log(`    ${chalk.red("✗")} ${fix.name} — ${chalk.gray(fix.error)}`);
        } else {
          console.log(`    ${chalk.green("✓")} ${fix.name}`);
        }
      }
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of report.results) {
    counts[result.status] += 1;
  }

  const parts = [
    chalk.green(`${counts.pass} passed`),
    counts.warn > 0 ? chalk.yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`) : null,
    counts.fail > 0 ? chalk.red(`${counts.fail} failed`) : null,
    counts.skip > 0 ? chalk.gray(`${counts.skip} skipped`) : null
  ].filter((part): part is string => part !== null);

  console.log("\n  " + parts.join(chalk.gray(", ")));

  if (counts.fail > 0) {
    console.log(chalk.red.bold("  Environment has problems — fix the failures above, then re-run `prowl doctor`.\n"));
  } else if (counts.warn > 0) {
    console.log(chalk.yellow.bold("  Environment is usable, with warnings.\n"));
  } else {
    console.log(chalk.green.bold("  Environment is healthy.\n"));
  }
}

export function buildDoctorCommand(deps: DoctorDeps = defaultDoctorDeps()): Command {
  return new Command("doctor")
    .description("Check that your environment is set up to run Prowl hunts")
    .option("--fix", "Attempt safe auto-repairs: install Chromium and scaffold a missing .prowl/")
    .action(async (options: { fix?: boolean }) => {
      try {
        const report = await runDoctor(deps, { fix: options.fix });
        renderReport(report, Boolean(options.fix));
        if (!report.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "doctor failed";
        console.error(chalk.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    });
}
