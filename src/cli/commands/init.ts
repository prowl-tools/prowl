import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { welcomeBanner } from "../mascot.js";
import { CONFIG_DIR } from "../../config/loader.js";

/** Persona-specific starter sets. Each maps to `examples/presets/<name>/`. */
export const PRESETS = ["solo", "team", "ci", "agent"] as const;
export type PresetName = (typeof PRESETS)[number];

export function isPresetName(value: string): value is PresetName {
  return (PRESETS as readonly string[]).includes(value);
}

interface StagedTemplateFile {
  source: string;
  relativePath: string;
}

interface DestinationBackup {
  destination: string;
  backup: string;
}

interface DestinationRollback {
  prowlDirExisted: boolean;
  backupDir: string;
  backups: DestinationBackup[];
  createdFiles: string[];
  createdDirs: string[];
}

function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  if (fs.existsSync(path.join(root, "package.json"))) {
    return root;
  }

  throw new Error("Cannot find package root. Reinstall prowl-tools.");
}

function copyFile(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function isInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
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

function assertNoSymlinkDestination(prowlDir: string, destination: string): void {
  const relative = path.relative(prowlDir, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside ${CONFIG_DIR}: ${destination}`);
  }

  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  let current = prowlDir;
  const rootStat = lstatIfExists(current);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(
      `${CONFIG_DIR} scaffold destination path contains a symlink: ${current}. ` +
        `Replace it with a real file or directory before running prowl init --force.`
    );
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new Error(`${CONFIG_DIR} scaffold path is not a directory: ${current}`);
  }

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] ?? "");
    const stat = lstatIfExists(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `${CONFIG_DIR} scaffold destination path contains a symlink: ${current}. ` +
          `Replace it with a real file or directory before running prowl init --force.`
      );
    }
    if (stat && index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${CONFIG_DIR} scaffold parent path is not a directory: ${current}`);
    }
  }
}

function gitignoreTemplate(): string {
  return [
    "# Run artifacts (screenshots, logs, reports)",
    "runs/",
    "",
    "# Auth state (tokens, cookies)",
    "auth-state.json",
    "",
    "# Environment variables (credentials)",
    ".env",
    "",
  ].join("\n");
}

function stageScaffoldTemplates(sourceDir: string): { stageDir: string; files: StagedTemplateFile[] } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-init-"));
  const files: StagedTemplateFile[] = [];

  try {
    copyFile(path.join(sourceDir, "config.yml"), path.join(stageDir, "config.yml"));
    files.push({ source: path.join(stageDir, "config.yml"), relativePath: "config.yml" });

    const exampleHuntsDir = path.join(sourceDir, "hunts");
    const huntFiles = fs.readdirSync(exampleHuntsDir).filter((f) => f.endsWith(".yml"));
    for (const huntFile of huntFiles) {
      const relativePath = path.join("hunts", huntFile);
      copyFile(path.join(exampleHuntsDir, huntFile), path.join(stageDir, relativePath));
      files.push({ source: path.join(stageDir, relativePath), relativePath });
    }

    const gitignorePath = path.join(stageDir, ".gitignore");
    fs.writeFileSync(gitignorePath, gitignoreTemplate());
    files.push({ source: gitignorePath, relativePath: ".gitignore" });

    // Extra top-level preset files that live directly under the source dir —
    // e.g. `github-workflow.example.yml` (ci), `.env.example` and `AGENTS.md`
    // (agent). `config.yml`, the `hunts/` directory, and `.gitignore` are all
    // handled above. The default `examples/` dir has no such extras, so the
    // standard scaffold is unaffected. Sorted for deterministic ordering.
    const extras = fs
      .readdirSync(sourceDir)
      .filter((entry) => {
        if (entry === "config.yml" || entry === ".gitignore") return false;
        return fs.statSync(path.join(sourceDir, entry)).isFile();
      })
      .sort();
    for (const extra of extras) {
      copyFile(path.join(sourceDir, extra), path.join(stageDir, extra));
      files.push({ source: path.join(stageDir, extra), relativePath: extra });
    }

    return { stageDir, files };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function trackCreatedParentDirs(destination: string, prowlDir: string, createdDirs: Set<string>): void {
  let dir = path.dirname(destination);
  while (isInsideDir(prowlDir, dir) && !fs.existsSync(dir)) {
    createdDirs.add(dir);
    dir = path.dirname(dir);
  }
}

function prepareDestinationRollback(prowlDir: string, files: StagedTemplateFile[]): DestinationRollback {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-init-rollback-"));
  const backups: DestinationBackup[] = [];
  const createdFiles: string[] = [];
  const createdDirs = new Set<string>();
  const prowlDirExisted = fs.existsSync(prowlDir);

  try {
    for (const file of files) {
      const destination = path.join(prowlDir, file.relativePath);
      assertNoSymlinkDestination(prowlDir, destination);

      const stat = lstatIfExists(destination);
      if (stat) {
        if (!stat.isFile()) {
          throw new Error(`${CONFIG_DIR} scaffold destination is not a regular file: ${destination}`);
        }
        const backup = path.join(backupDir, file.relativePath);
        copyFile(destination, backup);
        backups.push({ destination, backup });
      } else {
        createdFiles.push(destination);
      }

      if (prowlDirExisted) {
        trackCreatedParentDirs(destination, prowlDir, createdDirs);
      }
    }

    return {
      prowlDirExisted,
      backupDir,
      backups,
      createdFiles,
      createdDirs: [...createdDirs].sort((a, b) => b.length - a.length)
    };
  } catch (error) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

function rollbackDestination(prowlDir: string, rollback: DestinationRollback): void {
  if (!rollback.prowlDirExisted) {
    fs.rmSync(prowlDir, { recursive: true, force: true });
    return;
  }

  for (const file of rollback.createdFiles) {
    fs.rmSync(file, { force: true });
  }
  for (const backup of rollback.backups) {
    try {
      copyFile(backup.backup, backup.destination);
    } catch (error) {
      throw new Error(
        `Failed to restore ${backup.destination} from backup ${backup.backup}: ${errorMessage(error)}`
      );
    }
  }
  for (const dir of rollback.createdDirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Preserve any user/concurrent files created after rollback tracking.
    }
  }
}

/**
 * Scaffold a `.prowl/` directory under `root` from the package's bundled
 * templates: `config.yml`, the starter hunts, a `.gitignore` that keeps run
 * artifacts and secrets out of version control, and any extra preset files.
 * Without a `preset` it uses the default top-level `examples/` set (the exact
 * historical behavior); with one it uses `examples/presets/<preset>/`. This is
 * the single code path `prowl init` and `prowl doctor --fix` share — the latter
 * always scaffolds the default set — so the staging/rollback/symlink-safety
 * logic is never duplicated. Throws (rather than exiting) when the bundled
 * templates are missing, so callers can decide how to surface the failure.
 */
export function scaffoldProwlDir(root: string, preset?: PresetName): void {
  const prowlDir = path.join(root, CONFIG_DIR);

  const packageRoot = getPackageRoot();
  const examplesDir = path.join(packageRoot, "examples");
  const sourceDir = preset ? path.join(examplesDir, "presets", preset) : examplesDir;
  const sourceConfig = path.join(sourceDir, "config.yml");
  const sourceHuntsDir = path.join(sourceDir, "hunts");

  if (!fs.existsSync(sourceConfig) || !fs.existsSync(sourceHuntsDir)) {
    throw new Error(
      preset
        ? `Preset "${preset}" templates not found in package. Reinstall prowl-tools.`
        : "Examples not found in package. Reinstall prowl-tools."
    );
  }

  const staged = stageScaffoldTemplates(sourceDir);
  let rollback: DestinationRollback | null = null;
  let keepBackup = false;
  try {
    rollback = prepareDestinationRollback(prowlDir, staged.files);
    for (const file of staged.files) {
      copyFile(file.source, path.join(prowlDir, file.relativePath));
    }
  } catch (error) {
    if (rollback) {
      try {
        rollbackDestination(prowlDir, rollback);
      } catch (rollbackError) {
        keepBackup = true;
        throw new Error(
          `Scaffold failed: ${errorMessage(error)}. Rollback failed: ${errorMessage(rollbackError)}. ` +
            `Backup preserved at ${rollback.backupDir}.`
        );
      }
    }
    throw error;
  } finally {
    if (rollback && !keepBackup) {
      fs.rmSync(rollback.backupDir, { recursive: true, force: true });
    }
    fs.rmSync(staged.stageDir, { recursive: true, force: true });
  }
}

/** True only when both stdin and stdout are interactive terminals. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

interface PromptChoice {
  label: string;
  preset: PresetName | undefined;
  blurb: string;
}

const PROMPT_CHOICES: PromptChoice[] = [
  { label: "standard", preset: undefined, blurb: "default starter hunts (hello, login-flow, form, macOS)" },
  { label: "solo", preset: "solo", blurb: "minimal quick-start for a solo project" },
  { label: "team", preset: "team", blurb: "full guardrails + auth/CRUD/forms hunts" },
  { label: "ci", preset: "ci", blurb: "JUnit reports + a GitHub Actions workflow" },
  { label: "agent", preset: "agent", blurb: "JSON/MCP surface for AI agents" }
];

/**
 * Present a numbered menu of presets and resolve the chosen one. Uses only
 * `node:readline` (no dependencies). Enter with no choice, or any read failure,
 * resolves to `undefined` (the standard scaffold). Callers must confirm the
 * session is interactive before calling — non-TTY sessions never prompt.
 */
async function promptForPreset(): Promise<PresetName | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold("Choose a starting point:"));
    PROMPT_CHOICES.forEach((choice, index) => {
      console.log(`  ${index + 1}) ${chalk.cyan(choice.label)} — ${choice.blurb}`);
    });

    const answer = await new Promise<string>((resolve, reject) => {
      rl.once("error", reject);
      // Ctrl+D (EOF) closes the interface without ever invoking the question
      // callback — resolve to the standard scaffold instead of hanging.
      rl.once("close", () => resolve(""));
      rl.question("Enter choice [1]: ", resolve);
    });

    const trimmed = answer.trim();
    if (trimmed === "") {
      return undefined; // Enter with no choice → standard
    }

    const index = Number.parseInt(trimmed, 10);
    if (Number.isInteger(index) && index >= 1 && index <= PROMPT_CHOICES.length) {
      return PROMPT_CHOICES[index - 1]?.preset;
    }
    if (isPresetName(trimmed)) {
      return trimmed;
    }
    // Unrecognized input falls back to the safe default.
    return undefined;
  } catch {
    return undefined; // any read failure → standard
  } finally {
    rl.close();
  }
}

/**
 * Print the per-preset post-init guidance. The default (no preset) branch is
 * byte-identical to the historical `prowl init` output.
 */
function printPostInitHints(preset?: PresetName): void {
  const dir = CONFIG_DIR;
  switch (preset) {
    case "solo":
      console.log(chalk.gray("  Run ") + chalk.bold("prowl run hello") + chalk.gray(" to get started."));
      console.log(chalk.gray("  Point ") + chalk.cyan(`${dir}/config.yml`) + chalk.gray(" at your app, then try ") + chalk.cyan(`${dir}/hunts/first-flow.yml`) + chalk.gray("."));
      console.log(chalk.gray("  Desktop-first? Prowl drives native macOS apps too — see the macOS Target section of the README.") + "\n");
      break;
    case "team":
      console.log(chalk.gray("  Run ") + chalk.bold("prowl ci") + chalk.gray(" to run the whole suite."));
      console.log(chalk.gray("  Starters: ") + chalk.cyan(`${dir}/hunts/login-flow.yml`) + chalk.gray(" (auth), ") + chalk.cyan(`${dir}/hunts/crud.yml`) + chalk.gray(" (CRUD), ") + chalk.cyan(`${dir}/hunts/form.yml`) + chalk.gray(" (forms)."));
      console.log(chalk.gray("  Review the guardrails in ") + chalk.cyan(`${dir}/config.yml`) + chalk.gray(" (allowedDomains, forbiddenSelectors) before running against real data.") + "\n");
      break;
    case "ci":
      console.log(chalk.gray("  Run ") + chalk.bold("prowl ci --junit") + chalk.gray(" to produce JUnit reports."));
      console.log(chalk.gray("  Copy ") + chalk.cyan(`${dir}/github-workflow.example.yml`) + chalk.gray(" to ") + chalk.cyan(".github/workflows/prowl.yml") + chalk.gray(" to run hunts in GitHub Actions."));
      console.log(chalk.gray("  (prowl init only writes under ") + chalk.cyan(dir) + chalk.gray(", so the workflow ships there for you to move.)") + "\n");
      break;
    case "agent":
      console.log(chalk.gray("  Run ") + chalk.bold("prowl run hello --json") + chalk.gray(" for machine-readable output."));
      console.log(chalk.gray("  See ") + chalk.cyan(`${dir}/AGENTS.md`) + chalk.gray(" for the JSON/CLI/MCP surface and exit codes."));
      console.log(chalk.gray("  Copy ") + chalk.cyan(`${dir}/.env.example`) + chalk.gray(" to ") + chalk.cyan(`${dir}/.env`) + chalk.gray(" and fill in secrets.") + "\n");
      break;
    default:
      console.log(chalk.gray("  Run ") + chalk.bold("prowl run hello") + chalk.gray(" to get started."));
      console.log(chalk.gray("  See ") + chalk.cyan(`${dir}/hunts/login-flow.yml`) + chalk.gray(" (auth) and ") + chalk.cyan(`${dir}/hunts/form.yml`) + chalk.gray(" (web forms) for fuller examples."));
      console.log(chalk.gray("  Desktop-first? ") + chalk.cyan(`${dir}/hunts/macos-hello.yml`) + chalk.gray(" is a macOS starter (experimental — see its comments to enable).") + "\n");
  }
}

export function buildInitCommand(): Command {
  const command = new Command("init")
    .option("--force", `Overwrite existing ${CONFIG_DIR} directory`)
    .option(
      "--preset <name>",
      `Persona-specific starter set: ${PRESETS.join(", ")} (default: standard)`
    )
    .action(async (options) => {
      const root = process.cwd();
      const prowlDir = path.join(root, CONFIG_DIR);

      // Resolve an explicit --preset first so a typo fails fast, before any
      // prompt or filesystem work.
      let preset: PresetName | undefined;
      if (options.preset !== undefined) {
        if (!isPresetName(options.preset)) {
          console.error(
            chalk.red(`Unknown preset "${options.preset}". Choose one of: ${PRESETS.join(", ")}.`)
          );
          process.exitCode = 1;
          return;
        }
        preset = options.preset;
      }

      if (fs.existsSync(prowlDir) && !options.force) {
        console.error(
          chalk.red(
            `${CONFIG_DIR} already exists. Run with --force to reinitialize prowl configuration without deleting existing files.`
          )
        );
        process.exitCode = 1;
        return;
      }

      // Only prompt when no preset was given and the session is interactive.
      // Non-TTY sessions keep today's exact behavior (standard scaffold).
      if (options.preset === undefined && isInteractive()) {
        preset = await promptForPreset();
      }

      try {
        scaffoldProwlDir(root, preset);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : "init failed"));
        process.exitCode = 1;
        return;
      }

      console.log(welcomeBanner());
      console.log(chalk.green(`  Initialized ${CONFIG_DIR} directory.`));
      printPostInitHints(preset);
    });

  return command;
}
