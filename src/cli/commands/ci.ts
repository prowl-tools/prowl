import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { runSuite } from "../../runner/suite.js";
import { printHuntHeader, printStepResult, printHuntSummary } from "../output.js";
import { resultMascot } from "../mascot.js";
import { printCiSummary } from "../../reporter/ci-summary.js";
import type { CiHuntResult } from "../../types/index.js";

function parseTagList(value: string | undefined, flag: "--include-tags" | "--exclude-tags"): string[] | undefined {
  if (value === undefined) return undefined;
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error(`${flag} requires at least one non-empty tag`);
  }
  return tags;
}

function lstatIfExists(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Allow stable macOS root aliases so --output /tmp and os.tmpdir() paths keep working. */
function isTrustedPlatformSymlink(target: string): boolean {
  return process.platform === "darwin" && (target === "/tmp" || target === "/var");
}

/** Validate every existing component of an absolute --output path without following symlinks. */
function assertOutputDestinationSafe(outputDir: string): void {
  const { root } = path.parse(outputDir);
  const rootStat = lstatIfExists(root);
  const rootIsTrustedSymlink = rootStat?.isSymbolicLink() && isTrustedPlatformSymlink(root);
  if (rootStat?.isSymbolicLink() && !rootIsTrustedSymlink) {
    throw new Error(`--output path contains a symlink: ${root}`);
  }
  if (rootStat && !rootIsTrustedSymlink && !rootStat.isDirectory()) {
    throw new Error(`--output parent path is not a directory: ${root}`);
  }

  const parts = outputDir.slice(root.length).split(path.sep).filter((part) => part.length > 0);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] ?? "");
    const stat = lstatIfExists(current);
    const isTrustedSymlink = stat?.isSymbolicLink() && isTrustedPlatformSymlink(current);
    if (stat?.isSymbolicLink() && !isTrustedSymlink) {
      throw new Error(`--output path contains a symlink: ${current}`);
    }
    if (stat && !isTrustedSymlink && !stat.isDirectory()) {
      const label = index === parts.length - 1 ? "path exists and is not a directory" : "parent path is not a directory";
      throw new Error(`--output ${label}: ${current}`);
    }
  }
}

/** Resolve --output to an absolute directory and validate it before any hunts run. */
function resolveOutputDir(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const resolved = path.resolve(output);
  assertOutputDestinationSafe(resolved);
  return resolved;
}

/** Copy the canonical ci-result.json to the requested --output directory. */
function copyCiResultToOutput(outputDir: string, resultPath: string): string {
  assertOutputDestinationSafe(outputDir);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create --output directory ${outputDir}: ${errorMessage(error)}`, { cause: error });
  }

  const outputCopyPath = path.join(outputDir, "ci-result.json");
  try {
    fs.copyFileSync(resultPath, outputCopyPath);
  } catch (error) {
    throw new Error(
      `Failed to copy ci-result.json from ${resultPath} to --output destination ${outputCopyPath}: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  return outputCopyPath;
}

function printFailureDetails(results: CiHuntResult[]): void {
  for (const hunt of results) {
    if (hunt.status === "fail" && hunt.error) {
      console.error(`  ${chalk.red("Error")} ${hunt.hunt}: ${hunt.error}`);
    }
  }
}

export function buildCiCommand(): Command {
  const command = new Command("ci")
    .description("Run all hunts and produce a combined pass/fail result for CI pipelines")
    .option("--config <path>", "Custom config path")
    .option("--url <target>", "Override target URL")
    .option("--headed", "Show browser window")
    .option("--slow-mo <ms>", "Slow down Playwright actions", (value) => Number(value))
    .option("--trace", "Capture Playwright traces")
    .option("--browser <engine>", "Browser engine: chromium, firefox, or webkit")
    .option("--channel <name>", "Browser channel: chrome, msedge, chrome-beta, etc.")
    .option("--viewport <size>", "Viewport size: WxH (e.g. 1920x1080) or preset (mobile, tablet, desktop)")
    .option("--junit", "Generate JUnit XML reports")
    .option("--include-tags <tags>", "Only run hunts matching these tags (comma-separated)")
    .option("--exclude-tags <tags>", "Skip hunts matching these tags (comma-separated)")
    .option("--fail-fast", "Stop starting new hunts after the first failure (remaining hunts are skipped)")
    .option("--json", "Output results as JSON")
    .option("--output <dir>", "Also write a copy of ci-result.json into this directory (for CI artifact upload)")
    .option("--parallel <count>", "Run hunts in parallel with N workers", (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("--parallel must be a positive integer");
      }
      return n;
    })
    .action(async (options) => {
      const includeTags = parseTagList(options.includeTags as string | undefined, "--include-tags");
      const excludeTags = parseTagList(options.excludeTags as string | undefined, "--exclude-tags");
      // Validate --output before running any hunts so a bad path fails fast (exit 1).
      const outputDir = resolveOutputDir(options.output as string | undefined);

      const parallel = options.parallel as number | undefined;
      const isParallel = parallel !== undefined && parallel > 1;
      // Suppress per-hunt progress output for JSON and parallel runs (parallel output would interleave).
      const showProgress = !options.json && !isParallel;

      const { result, resultPath } = await runSuite({
        configPath: options.config,
        urlOverride: options.url,
        headed: Boolean(options.headed),
        slowMo: Number.isFinite(options.slowMo) ? options.slowMo : undefined,
        trace: Boolean(options.trace),
        browser: options.browser,
        channel: options.channel,
        viewport: options.viewport,
        // Pass through undefined when --junit is absent so config-level
        // `artifacts.junit` is honored (flag overrides config).
        junit: options.junit ? true : undefined,
        includeTags,
        excludeTags,
        parallel,
        failFast: Boolean(options.failFast),
        hooks: {
          onHuntStart: showProgress ? (huntName) => printHuntHeader(huntName) : undefined,
          onStep: showProgress
            ? (stepResult, step, index) => printStepResult(stepResult, step, index)
            : undefined,
          onHuntSuccess: showProgress
            ? (huntName, runResult, runDir) => {
                console.log(resultMascot(runResult.status, huntName));
                printHuntSummary(runResult, runDir);
              }
            : undefined,
          onHuntFailure: showProgress
            ? (huntName, message) => {
                console.log(resultMascot("fail", huntName));
                console.error(`\n  Error: ${message}\n`);
              }
            : undefined,
          onHuntSkipped: options.json
            ? undefined
            : (huntName, reason) => {
                const why =
                  reason === "include"
                    ? "no matching include tags"
                    : reason === "exclude"
                      ? "matched exclude tags"
                      : "fail-fast: an earlier hunt failed";
                console.log(chalk.yellow(`  ○ Skipped "${huntName}" — ${why}`));
              }
        }
      });

      if (result.status === "no-hunts") {
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.yellow("\n  No hunts found. Create hunts in .prowl/hunts/\n"));
        }
        process.exitCode = 2;
        return;
      }

      // Write the additional --output copy of ci-result.json. The canonical copy in
      // the run directory (resultPath) is untouched. Nothing is written when the suite
      // produced no result file (e.g. no-hunts already returned above; resultPath null).
      let outputCopyPath: string | undefined;
      if (outputDir && resultPath) {
        outputCopyPath = copyCiResultToOutput(outputDir, resultPath);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printCiSummary(result.hunts, result.durationMs, result.flaky, result.clusters);
        if (!showProgress) {
          printFailureDetails(result.hunts);
        }
        if (resultPath) {
          console.log(`\n  CI Result: ${chalk.gray(resultPath)}\n`);
        }
        if (outputCopyPath) {
          console.log(`  Output copy: ${chalk.gray(outputCopyPath)}\n`);
        }
        if (result.status === "all-skipped") {
          console.log(chalk.yellow("  All hunts were skipped by tag filters.\n"));
        }
      }

      if (result.status === "fail") {
        process.exitCode = 1;
      } else if (result.status === "all-skipped") {
        process.exitCode = 2;
      } else {
        process.exitCode = 0;
      }
    });

  return command;
}
