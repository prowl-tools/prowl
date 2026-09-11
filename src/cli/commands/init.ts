import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { welcomeBanner } from "../mascot.js";
import { CONFIG_DIR } from "../../config/loader.js";

interface StagedTemplateFile {
  source: string;
  relativePath: string;
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

function stageScaffoldTemplates(examplesDir: string): { stageDir: string; files: StagedTemplateFile[] } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-init-"));
  const files: StagedTemplateFile[] = [];

  try {
    copyFile(path.join(examplesDir, "config.yml"), path.join(stageDir, "config.yml"));
    files.push({ source: path.join(stageDir, "config.yml"), relativePath: "config.yml" });

    const exampleHuntsDir = path.join(examplesDir, "hunts");
    const huntFiles = fs.readdirSync(exampleHuntsDir).filter((f) => f.endsWith(".yml"));
    for (const huntFile of huntFiles) {
      const relativePath = path.join("hunts", huntFile);
      copyFile(path.join(exampleHuntsDir, huntFile), path.join(stageDir, relativePath));
      files.push({ source: path.join(stageDir, relativePath), relativePath });
    }

    const gitignorePath = path.join(stageDir, ".gitignore");
    fs.writeFileSync(gitignorePath, gitignoreTemplate());
    files.push({ source: gitignorePath, relativePath: ".gitignore" });

    return { stageDir, files };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Scaffold a `.prowl/` directory under `root` from the package's bundled
 * `examples/` templates: `config.yml`, the starter hunts, and a `.gitignore`
 * that keeps run artifacts and secrets out of version control. This is the
 * single code path both `prowl init` and `prowl doctor --fix` use so the
 * templates are never duplicated. Throws (rather than exiting) when the bundled
 * examples are missing, so callers can decide how to surface the failure.
 */
export function scaffoldProwlDir(root: string): void {
  const prowlDir = path.join(root, CONFIG_DIR);

  const packageRoot = getPackageRoot();
  const examplesDir = path.join(packageRoot, "examples");
  const exampleConfig = path.join(examplesDir, "config.yml");
  const exampleHuntsDir = path.join(examplesDir, "hunts");

  if (!fs.existsSync(exampleConfig) || !fs.existsSync(exampleHuntsDir)) {
    throw new Error("Examples not found in package. Reinstall prowl-tools.");
  }

  const staged = stageScaffoldTemplates(examplesDir);
  try {
    for (const file of staged.files) {
      copyFile(file.source, path.join(prowlDir, file.relativePath));
    }
  } finally {
    fs.rmSync(staged.stageDir, { recursive: true, force: true });
  }
}

export function buildInitCommand(): Command {
  const command = new Command("init")
    .option("--force", `Overwrite existing ${CONFIG_DIR} directory`)
    .action((options) => {
      const root = process.cwd();
      const prowlDir = path.join(root, CONFIG_DIR);
      if (fs.existsSync(prowlDir) && !options.force) {
        console.error(
          chalk.red(
            `${CONFIG_DIR} already exists. Run with --force to reinitialize prowl configuration without deleting existing files.`
          )
        );
        process.exitCode = 1;
        return;
      }

      try {
        scaffoldProwlDir(root);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : "init failed"));
        process.exitCode = 1;
        return;
      }

      console.log(welcomeBanner());
      console.log(chalk.green(`  Initialized ${CONFIG_DIR} directory.`));
      console.log(chalk.gray("  Run ") + chalk.bold("prowl run hello") + chalk.gray(" to get started."));
      console.log(chalk.gray("  See ") + chalk.cyan(`${CONFIG_DIR}/hunts/login-flow.yml`) + chalk.gray(" for a fuller example.") + "\n");
    });

  return command;
}
