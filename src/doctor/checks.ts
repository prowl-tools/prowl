/**
 * PROWL-026 / P6-003 — `prowl doctor` environment health check.
 *
 * The checks are pure functions over an injected {@link DoctorDeps} seam (Node
 * version, platform, cwd, env, a Playwright probe, a command runner, config
 * loading, macdriver status, and the two `--fix` repairs). Nothing here touches
 * the real system unless {@link defaultDoctorDeps} wires in the real
 * implementations, so Vitest can drive every pass/fail/warn/skip/fix path
 * without a real Node, browser, config, or native toolchain.
 *
 * A check is `{ name, status, message, fixable }`:
 *   - `pass`  (green ✓)  — healthy.
 *   - `warn`  (yellow ⚠) — non-blocking; a hunt can still run (e.g. no `.prowl/`
 *                          yet, which `prowl init` creates on demand).
 *   - `fail`  (red ✗)    — breaks runs; drives the exit code to 1.
 *   - `skip`  (gray ○)   — not applicable / a prerequisite check already failed.
 *
 * Only two repairs are ever attempted by `--fix`: installing Chromium and
 * scaffolding `.prowl/` via the same code path `prowl init` uses. Every other
 * failing check prints its manual remedy. System tools are never installed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../types/index.js";
import { loadConfig as loadProwlConfig, CONFIG_DIR, findConfigPath } from "../config/loader.js";
import { collectMacdriverStatus, type MacdriverStatus } from "../browser/macdriver-install.js";
import { scaffoldProwlDir } from "../cli/commands/init.js";

const execFileAsync = promisify(execFile);

/** Minimum supported Node.js major version. */
export const MIN_NODE_MAJOR = 20;

/** Stable check names — also used to route `--fix` repairs to the right check. */
export const CHECK_NODE = "Node.js version";
export const CHECK_PLAYWRIGHT = "Playwright installed";
export const CHECK_CHROMIUM = "Chromium browser";
export const CHECK_PROWL_DIR = ".prowl/ directory";
export const CHECK_CONFIG = "config.yml valid";
export const CHECK_MACOS = "macOS helper (prowl-macdriver)";
export const CHECK_IOS = "iOS tooling (xcrun simctl)";
export const CHECK_ANDROID = "Android tooling (adb)";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  /** Whether `prowl doctor --fix` can repair this failing/warning check. */
  fixable: boolean;
}

/** Result of probing whether Playwright and its Chromium browser are present. */
export interface PlaywrightProbeResult {
  playwrightInstalled: boolean;
  chromiumPath: string | null;
  chromiumInstalled: boolean;
}

export interface CommandResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

/** A command runner used for cheap tool-reachability probes (xcrun, adb). */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

/** Every side effect `prowl doctor` performs, injectable for tests. */
export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  cwd: string;
  env: NodeJS.ProcessEnv;
  probePlaywright: () => Promise<PlaywrightProbeResult>;
  runCommand: CommandRunner;
  prowlDirExists: (cwd: string) => boolean;
  loadConfig: () => { config: Config };
  collectMacdriverStatus: (options?: { env?: NodeJS.ProcessEnv }) => Promise<MacdriverStatus>;
  /** `--fix`: install the Chromium browser (`npx playwright install chromium`). */
  installChromium: () => Promise<void>;
  /** `--fix`: scaffold `.prowl/` via the same code path `prowl init` uses. */
  scaffoldProwlDir: (cwd: string) => void;
}

export interface FixOutcome {
  name: string;
  error?: string;
}

export interface DoctorReport {
  results: CheckResult[];
  fixes: FixOutcome[];
  /** True when no check failed (warnings are acceptable). */
  ok: boolean;
}

function nodeMajor(version: string): number {
  const cleaned = version.startsWith("v") ? version.slice(1) : version;
  return Number.parseInt(cleaned.split(".")[0] ?? "", 10);
}

export function checkNode(nodeVersion: string): CheckResult {
  const major = nodeMajor(nodeVersion);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return {
      name: CHECK_NODE,
      status: "pass",
      message: `Node ${nodeVersion} (>= ${MIN_NODE_MAJOR} required)`,
      fixable: false
    };
  }
  return {
    name: CHECK_NODE,
    status: "fail",
    message:
      `Node ${nodeVersion} is too old — Prowl needs Node >= ${MIN_NODE_MAJOR}. ` +
      "Upgrade with nvm (`nvm install 20`), Homebrew (`brew install node`), or nodejs.org.",
    fixable: false
  };
}

export function checkPlaywright(probe: PlaywrightProbeResult): CheckResult {
  if (probe.playwrightInstalled) {
    return { name: CHECK_PLAYWRIGHT, status: "pass", message: "Playwright is installed", fixable: false };
  }
  return {
    name: CHECK_PLAYWRIGHT,
    status: "fail",
    message:
      "Playwright is not installed. It ships as a dependency of prowl-tools — reinstall with " +
      "`npm install` (local) or `npm install -g prowl-tools` (global).",
    fixable: false
  };
}

export function checkChromium(probe: PlaywrightProbeResult): CheckResult {
  if (!probe.playwrightInstalled) {
    return {
      name: CHECK_CHROMIUM,
      status: "skip",
      message: "Skipped — Playwright is not installed",
      fixable: false
    };
  }
  if (probe.chromiumInstalled) {
    return {
      name: CHECK_CHROMIUM,
      status: "pass",
      message: `Chromium is available${probe.chromiumPath ? ` (${probe.chromiumPath})` : ""}`,
      fixable: false
    };
  }
  return {
    name: CHECK_CHROMIUM,
    status: "fail",
    message:
      "Chromium is not installed. Run `npx playwright install chromium` " +
      "(or `prowl doctor --fix`).",
    fixable: true
  };
}

export function checkProwlDir(exists: boolean): CheckResult {
  if (exists) {
    return { name: CHECK_PROWL_DIR, status: "pass", message: `${CONFIG_DIR}/ exists`, fixable: false };
  }
  return {
    name: CHECK_PROWL_DIR,
    status: "warn",
    message:
      `No ${CONFIG_DIR}/ directory here. Run \`prowl init\` (or \`prowl doctor --fix\`) ` +
      "to scaffold config and starter hunts.",
    fixable: true
  };
}

export function checkConfig(
  prowlDirExists: boolean,
  loadConfig: () => { config: Config }
): { result: CheckResult; config: Config | null } {
  if (!prowlDirExists) {
    return {
      result: {
        name: CHECK_CONFIG,
        status: "skip",
        message: `Skipped — no ${CONFIG_DIR}/ directory`,
        fixable: false
      },
      config: null
    };
  }
  try {
    const { config } = loadConfig();
    return {
      result: {
        name: CHECK_CONFIG,
        status: "pass",
        message: `Valid (target: ${config.target.type})`,
        fixable: false
      },
      config
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      result: {
        name: CHECK_CONFIG,
        status: "fail",
        message: `Invalid config: ${detail}`,
        fixable: false
      },
      config: null
    };
  }
}

type MacdriverSource = "env" | "user-install" | "source-build";

function macdriverSourceLabel(source: MacdriverSource): string {
  switch (source) {
    case "env":
      return "PROWL_MACDRIVER_BIN override";
    case "user-install":
      return "user install (~/.prowl/macdriver)";
    case "source-build":
      return "repo source build";
  }
}

export async function checkMacTarget(
  collect: DoctorDeps["collectMacdriverStatus"],
  env: NodeJS.ProcessEnv
): Promise<CheckResult> {
  const status = await collect({ env });
  if (status.resolved) {
    return {
      name: CHECK_MACOS,
      status: "pass",
      message:
        `Resolved via ${macdriverSourceLabel(status.resolved.source)}: ${status.resolved.path}. ` +
        "Verify Accessibility/Screen Recording permissions with `prowl macdriver status`.",
      fixable: false
    };
  }
  return {
    name: CHECK_MACOS,
    status: "fail",
    message:
      "prowl-macdriver helper not found. Install it with `prowl macdriver install`, " +
      "then check permissions with `prowl macdriver status`.",
    fixable: false
  };
}

export async function checkIosTarget(
  platform: NodeJS.Platform,
  run: CommandRunner
): Promise<CheckResult> {
  if (platform !== "darwin") {
    return {
      name: CHECK_IOS,
      status: "fail",
      message: `The iOS target requires macOS; xcrun simctl is unavailable on ${platform}.`,
      fixable: false
    };
  }
  try {
    await run("xcrun", ["simctl", "help"]);
    return { name: CHECK_IOS, status: "pass", message: "xcrun simctl is reachable", fixable: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_IOS,
      status: "fail",
      message:
        `xcrun simctl is not reachable (${detail}). Install Xcode and its command-line tools ` +
        "(`xcode-select --install`), then open Xcode once to finish setup.",
      fixable: false
    };
  }
}

export async function checkAndroidTarget(run: CommandRunner): Promise<CheckResult> {
  try {
    await run("adb", ["version"]);
    return { name: CHECK_ANDROID, status: "pass", message: "adb is reachable", fixable: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: CHECK_ANDROID,
      status: "fail",
      message:
        `adb is not reachable (${detail}). Install Android platform-tools and add it to your PATH ` +
        "(e.g. `brew install --cask android-platform-tools`, or via Android Studio's SDK Manager).",
      fixable: false
    };
  }
}

/** Run every applicable check once and return the results in display order. */
export async function runDoctorChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const probe = await deps.probePlaywright();
  results.push(checkNode(deps.nodeVersion));
  results.push(checkPlaywright(probe));
  results.push(checkChromium(probe));

  const prowlExists = deps.prowlDirExists(deps.cwd);
  results.push(checkProwlDir(prowlExists));

  const { result: configResult, config } = checkConfig(prowlExists, deps.loadConfig);
  results.push(configResult);

  // Target-aware checks run only for a valid config, and only for the
  // configured target (desktop-first: macOS is checked in depth; the web
  // target needs nothing beyond the core checks above).
  if (config) {
    switch (config.target.type) {
      case "macos":
        results.push(await checkMacTarget(deps.collectMacdriverStatus, deps.env));
        break;
      case "ios":
        results.push(await checkIosTarget(deps.platform, deps.runCommand));
        break;
      case "android":
        results.push(await checkAndroidTarget(deps.runCommand));
        break;
      default:
        break;
    }
  }

  return results;
}

/**
 * Run the checks, optionally apply the two safe `--fix` repairs to fixable
 * non-passing checks, then re-run every check so the report reflects the
 * post-fix state. Exit-worthiness (`ok`) is decided on the final results.
 */
export async function runDoctor(
  deps: DoctorDeps,
  options: { fix?: boolean } = {}
): Promise<DoctorReport> {
  let results = await runDoctorChecks(deps);
  const fixes: FixOutcome[] = [];

  if (options.fix) {
    for (const result of results) {
      if (!result.fixable || result.status === "pass" || result.status === "skip") {
        continue;
      }
      try {
        if (result.name === CHECK_CHROMIUM) {
          await deps.installChromium();
          fixes.push({ name: result.name });
        } else if (result.name === CHECK_PROWL_DIR) {
          deps.scaffoldProwlDir(deps.cwd);
          fixes.push({ name: result.name });
        }
      } catch (error) {
        fixes.push({
          name: result.name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (fixes.length > 0) {
      results = await runDoctorChecks(deps);
    }
  }

  const ok = !results.some((result) => result.status === "fail");
  return { results, fixes, ok };
}

async function defaultProbePlaywright(): Promise<PlaywrightProbeResult> {
  try {
    const pw = await import("playwright");
    let chromiumPath: string | null = null;
    try {
      chromiumPath = pw.chromium.executablePath();
    } catch {
      chromiumPath = null;
    }
    const chromiumInstalled = chromiumPath ? fs.existsSync(chromiumPath) : false;
    return { playwrightInstalled: true, chromiumPath, chromiumInstalled };
  } catch {
    return { playwrightInstalled: false, chromiumPath: null, chromiumInstalled: false };
  }
}

const defaultRunCommand: CommandRunner = async (file, args) =>
  execFileAsync(file, args, { timeout: 5000 }) as Promise<CommandResult>;

async function defaultInstallChromium(): Promise<void> {
  // Five-minute ceiling: a first-time Chromium download can be large.
  await execFileAsync("npx", ["playwright", "install", "chromium"], { timeout: 300000 });
}

/** Real implementations of every seam, for production use. */
export function defaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: process.cwd(),
    env: process.env,
    probePlaywright: defaultProbePlaywright,
    runCommand: defaultRunCommand,
    prowlDirExists: (cwd) => fs.existsSync(path.join(cwd, CONFIG_DIR)) || findConfigPath(cwd) !== null,
    loadConfig: () => loadProwlConfig(),
    collectMacdriverStatus,
    installChromium: defaultInstallChromium,
    scaffoldProwlDir
  };
}
