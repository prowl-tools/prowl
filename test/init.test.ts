import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildInitCommand, scaffoldProwlDir, PRESETS, isPresetName } from "../src/cli/commands/init.js";
import { CONFIG_DIR, loadHunt } from "../src/config/loader.js";

describe("prowl init", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-init-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runInit(args: string[] = []) {
    const cmd = buildInitCommand();
    cmd.parse(["node", "prowl", ...args]);
  }

  async function runInitAsync(args: string[] = []) {
    const cmd = buildInitCommand();
    await cmd.parseAsync(["node", "prowl", ...args]);
  }

  function failDestinationHuntCopies(prowlDir: string) {
    const copyFileSync = fs.copyFileSync;
    return vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (String(destination).startsWith(path.join(prowlDir, "hunts") + path.sep)) {
        throw new Error("destination copy failed");
      }
      copyFileSync(source, destination, mode);
    });
  }

  it("creates .prowl directory with config, starter hunts, and .gitignore", () => {
    runInit();

    const prowlDir = path.join(tempDir, ".prowl");
    expect(fs.existsSync(path.join(prowlDir, "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "hello.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "login-flow.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "form.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "macos-hello.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, ".gitignore"))).toBe(true);
  });

  it("prints the bundled login-flow starter path on success", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      runInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${CONFIG_DIR}/hunts/login-flow.yml`)
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("creates a valid login-flow starter hunt", () => {
    runInit();

    const hunt = loadHunt("login-flow", path.join(tempDir, ".prowl"));

    expect(hunt).toMatchObject({
      name: "login-flow",
      vars: {
        EMAIL: "{{TEST_EMAIL}}",
        PASSWORD: "{{TEST_PASSWORD}}",
      },
      assertions: [
        { urlIncludes: "/dashboard" },
        { noConsoleErrors: true },
      ],
    });
    expect(hunt.steps).toEqual([
      { navigate: "/login" },
      { fill: { Email: "{{EMAIL}}" } },
      { fill: { Password: "{{PASSWORD}}" } },
      { click: "Sign In" },
      { waitForUrl: { value: "/dashboard", timeout: 10000 } },
      { assert: { visible: "Dashboard" } },
    ]);
  });

  it("creates a valid form starter hunt", () => {
    runInit();

    const hunt = loadHunt("form", path.join(tempDir, ".prowl"));

    expect(hunt).toMatchObject({
      name: "form",
      tags: ["forms", "input"],
      assertions: [
        { urlIncludes: "/welcome" },
        { noConsoleErrors: true },
      ],
    });
    expect(hunt.steps).toEqual([
      { navigate: "/signup" },
      { fill: { "Full name": "Ada Lovelace" } },
      { fill: { Email: "ada@example.com" } },
      { select: { Plan: "Pro" } },
      { click: "I agree to the terms" },
      { click: "Create account" },
      { assert: { visible: "Welcome, Ada" } },
    ]);
  });

  it("creates a valid macOS starter hunt using only portable steps", () => {
    runInit();

    const hunt = loadHunt("macos-hello", path.join(tempDir, ".prowl"));

    expect(hunt).toMatchObject({
      name: "macos-hello",
      tags: ["macos", "smoke"],
    });
    expect(hunt.steps).toEqual([
      { type: "Hello from Prowl!" },
      { assert: { visible: "Hello from Prowl!" } },
    ]);
    // macOS hunts carry no web-only top-level assertions (noConsoleErrors etc.).
    expect(hunt.assertions).toBeUndefined();
  });

  it("prints the bundled form and macOS starter paths on success", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      runInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${CONFIG_DIR}/hunts/form.yml`)
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${CONFIG_DIR}/hunts/macos-hello.yml`)
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it(".gitignore ignores runs, auth-state.json, and .env", () => {
    runInit();

    const gitignore = fs.readFileSync(
      path.join(tempDir, ".prowl", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("runs/");
    expect(gitignore).toContain("auth-state.json");
    expect(gitignore).toContain(".env");
  });

  it(".gitignore does not ignore hunts or config", () => {
    runInit();

    const gitignore = fs.readFileSync(
      path.join(tempDir, ".prowl", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).not.toContain("hunts");
    expect(gitignore).not.toContain("config");
  });

  it("--force recreates .prowl including .gitignore", () => {
    runInit();

    // Remove .gitignore to simulate old init without it
    fs.unlinkSync(path.join(tempDir, ".prowl", ".gitignore"));
    expect(fs.existsSync(path.join(tempDir, ".prowl", ".gitignore"))).toBe(false);

    runInit(["--force"]);
    expect(fs.existsSync(path.join(tempDir, ".prowl", ".gitignore"))).toBe(true);
  });

  it("shows non-destructive guidance when .prowl exists without --force", () => {
    runInit();
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      runInit();

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("without deleting existing files")
      );
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("--force preserves user-created files not in templates", () => {
    runInit();

    // Create a user-owned file inside .prowl
    const userFile = path.join(tempDir, ".prowl", "my-notes.txt");
    fs.writeFileSync(userFile, "user data");

    // Create a user-owned hunt file
    const userHunt = path.join(tempDir, ".prowl", "hunts", "my-custom.yml");
    fs.writeFileSync(userHunt, "steps:\n  - navigate: /custom");

    runInit(["--force"]);

    // User files should still exist
    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.readFileSync(userFile, "utf-8")).toBe("user data");
    expect(fs.existsSync(userHunt)).toBe(true);
    expect(fs.readFileSync(userHunt, "utf-8")).toBe("steps:\n  - navigate: /custom");

    // Template files should be refreshed
    expect(fs.existsSync(path.join(tempDir, ".prowl", "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, ".prowl", ".gitignore"))).toBe(true);
  });

  it("does not create .prowl/ when template staging fails", () => {
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("copy failed");
    });

    try {
      expect(() => scaffoldProwlDir(tempDir)).toThrow("copy failed");
      expect(fs.existsSync(path.join(tempDir, ".prowl"))).toBe(false);
    } finally {
      copySpy.mockRestore();
    }
  });

  it("removes a partial .prowl/ when destination copying fails", () => {
    const prowlDir = path.join(tempDir, ".prowl");
    const copySpy = failDestinationHuntCopies(prowlDir);

    try {
      expect(() => scaffoldProwlDir(tempDir)).toThrow("destination copy failed");
      expect(fs.existsSync(prowlDir)).toBe(false);
    } finally {
      copySpy.mockRestore();
    }
  });

  it("restores existing .prowl/ files when destination copying fails under --force", () => {
    runInit();

    const prowlDir = path.join(process.cwd(), ".prowl");
    const configPath = path.join(prowlDir, "config.yml");
    fs.writeFileSync(configPath, "user config");
    const userFile = path.join(prowlDir, "my-notes.txt");
    fs.writeFileSync(userFile, "user data");

    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const copySpy = failDestinationHuntCopies(prowlDir);

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("destination copy failed"));
      expect(fs.existsSync(prowlDir)).toBe(true);
      expect(fs.readFileSync(configPath, "utf-8")).toBe("user config");
      expect(fs.readFileSync(userFile, "utf-8")).toBe("user data");
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it("rejects symlinked template files under --force", () => {
    runInit();

    const prowlDir = path.join(process.cwd(), ".prowl");
    const outsideFile = path.join(tempDir, "outside-config.yml");
    fs.writeFileSync(outsideFile, "outside config");
    const configPath = path.join(prowlDir, "config.yml");
    fs.unlinkSync(configPath);
    fs.symlinkSync(outsideFile, configPath);

    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("contains a symlink"));
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside config");
      expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("rejects symlinked template parent directories under --force", () => {
    runInit();

    const prowlDir = path.join(process.cwd(), ".prowl");
    const outsideHuntsDir = path.join(tempDir, "outside-hunts");
    fs.mkdirSync(outsideHuntsDir);
    const outsideHunt = path.join(outsideHuntsDir, "hello.yml");
    fs.writeFileSync(outsideHunt, "outside hunt");
    const huntsDir = path.join(prowlDir, "hunts");
    fs.rmSync(huntsDir, { recursive: true, force: true });
    fs.symlinkSync(outsideHuntsDir, huntsDir);

    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("contains a symlink"));
      expect(fs.readFileSync(outsideHunt, "utf-8")).toBe("outside hunt");
      expect(fs.lstatSync(huntsDir).isSymbolicLink()).toBe(true);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("rejects non-regular template destinations under --force", () => {
    runInit();

    const prowlDir = path.join(process.cwd(), ".prowl");
    const configPath = path.join(prowlDir, "config.yml");
    fs.unlinkSync(configPath);
    fs.mkdirSync(configPath);

    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not a regular file"));
      expect(fs.statSync(configPath).isDirectory()).toBe(true);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("preserves rollback backups when destination restoration fails under --force", () => {
    runInit();

    const prowlDir = path.join(process.cwd(), ".prowl");
    const configPath = path.join(prowlDir, "config.yml");
    fs.writeFileSync(configPath, "user config");
    const realCopyFileSync = fs.copyFileSync;
    let destinationFailed = false;
    let backupDir: string | null = null;
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      const sourcePath = String(source);
      const destinationPath = String(destination);
      if (sourcePath.includes("prowl-init-rollback-") && destinationPath === configPath) {
        throw new Error("restore failed");
      }
      if (!destinationFailed && destinationPath.startsWith(path.join(prowlDir, "hunts") + path.sep)) {
        destinationFailed = true;
        throw new Error("destination copy failed");
      }
      realCopyFileSync(source, destination, mode);
    });
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      const errorOutput = errorSpy.mock.calls.flat().join("\n");
      const match = errorOutput.match(/Backup preserved at (.+)\./);
      backupDir = match?.[1] ?? null;

      expect(process.exitCode).toBe(1);
      expect(errorOutput).toContain("Scaffold failed: destination copy failed");
      expect(errorOutput).toContain("Rollback failed: Failed to restore");
      expect(backupDir).not.toBeNull();
      expect(fs.existsSync(backupDir as string)).toBe(true);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
      copySpy.mockRestore();
      if (backupDir) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    }
  });

  it("preserves existing .prowl/ files when template staging fails under --force", () => {
    runInit();

    const userFile = path.join(tempDir, ".prowl", "my-notes.txt");
    fs.writeFileSync(userFile, "user data");
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("copy failed");
    });

    try {
      process.exitCode = undefined;
      runInit(["--force"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("copy failed"));
      expect(fs.existsSync(path.join(tempDir, ".prowl"))).toBe(true);
      expect(fs.readFileSync(userFile, "utf-8")).toBe("user data");
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
      copySpy.mockRestore();
    }
  });
});

describe("prowl init --preset", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-init-preset-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runInit(args: string[] = []) {
    const cmd = buildInitCommand();
    await cmd.parseAsync(["node", "prowl", ...args]);
  }

  function prowlPath(...parts: string[]): string {
    return path.join(tempDir, ".prowl", ...parts);
  }

  function exists(...parts: string[]): boolean {
    return fs.existsSync(prowlPath(...parts));
  }

  it("PRESETS lists the four persona presets", () => {
    expect([...PRESETS]).toEqual(["solo", "team", "ci", "agent"]);
    expect(isPresetName("solo")).toBe(true);
    expect(isPresetName("bogus")).toBe(false);
  });

  it("solo scaffolds a minimal starter set (hello + first-flow only)", async () => {
    await runInit(["--preset", "solo"]);

    expect(exists("config.yml")).toBe(true);
    expect(exists(".gitignore")).toBe(true);
    expect(exists("hunts", "hello.yml")).toBe(true);
    expect(exists("hunts", "first-flow.yml")).toBe(true);
    // solo omits the fuller/default starters
    expect(exists("hunts", "login-flow.yml")).toBe(false);
    expect(exists("hunts", "macos-hello.yml")).toBe(false);
  });

  it("team scaffolds auth, CRUD, and form hunts with guardrails in config", async () => {
    await runInit(["--preset", "team"]);

    expect(exists("hunts", "login-flow.yml")).toBe(true);
    expect(exists("hunts", "crud.yml")).toBe(true);
    expect(exists("hunts", "form.yml")).toBe(true);

    const config = fs.readFileSync(prowlPath("config.yml"), "utf-8");
    expect(config).toContain("forbiddenSelectors");
    expect(config).toContain("allowedDomains");
    expect(config).toContain("maxSteps");
  });

  it("ci enables JUnit and ships a GitHub Actions workflow template", async () => {
    await runInit(["--preset", "ci"]);

    const config = fs.readFileSync(prowlPath("config.yml"), "utf-8");
    expect(config).toContain("junit: true");

    expect(exists("github-workflow.example.yml")).toBe(true);
    const workflow = fs.readFileSync(prowlPath("github-workflow.example.yml"), "utf-8");
    expect(workflow).toContain("prowl ci --junit");

    // The workflow must NOT be written outside .prowl/ — scaffold safety.
    expect(fs.existsSync(path.join(tempDir, ".github"))).toBe(false);
  });

  it("agent ships an AGENTS.md surface guide and an .env.example", async () => {
    await runInit(["--preset", "agent"]);

    expect(exists("hunts", "assertions.yml")).toBe(true);
    expect(exists(".env.example")).toBe(true);
    expect(exists("AGENTS.md")).toBe(true);

    const agents = fs.readFileSync(prowlPath("AGENTS.md"), "utf-8");
    expect(agents).toContain("prowl run");
    expect(agents).toContain("--json");
    expect(agents).toContain("prowl mcp");
  });

  it("all presets produce a .gitignore and a config.yml", async () => {
    for (const preset of PRESETS) {
      fs.rmSync(path.join(tempDir, ".prowl"), { recursive: true, force: true });
      await runInit(["--preset", preset]);
      expect(exists("config.yml")).toBe(true);
      expect(exists(".gitignore")).toBe(true);
    }
  });

  it("rejects an unknown preset with exit code 1", async () => {
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      await runInit(["--preset", "enterprise"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown preset "enterprise"'));
      expect(fs.existsSync(path.join(tempDir, ".prowl"))).toBe(false);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("non-TTY with no --preset falls back to the standard scaffold", async () => {
    // stdin/stdout are not TTYs under the test runner, so no prompt fires.
    await runInit();

    // Standard scaffold ships the default four hunts (including macOS starter).
    expect(exists("hunts", "hello.yml")).toBe(true);
    expect(exists("hunts", "login-flow.yml")).toBe(true);
    expect(exists("hunts", "form.yml")).toBe(true);
    expect(exists("hunts", "macos-hello.yml")).toBe(true);
    // Preset-only extras must not appear in the standard scaffold.
    expect(exists("github-workflow.example.yml")).toBe(false);
    expect(exists("AGENTS.md")).toBe(false);
  });

  it("scaffoldProwlDir() with no preset matches the standard scaffold (doctor --fix path)", () => {
    scaffoldProwlDir(tempDir);

    // doctor --fix calls scaffoldProwlDir(cwd) with no preset — unchanged set.
    expect(exists("hunts", "hello.yml")).toBe(true);
    expect(exists("hunts", "macos-hello.yml")).toBe(true);
    expect(exists("github-workflow.example.yml")).toBe(false);
  });

  it("rolls back a partial preset scaffold when destination copying fails", () => {
    const prowlDir = path.join(tempDir, ".prowl");
    const copyFileSync = fs.copyFileSync;
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (String(destination).startsWith(path.join(prowlDir, "hunts") + path.sep)) {
        throw new Error("destination copy failed");
      }
      copyFileSync(source, destination, mode);
    });

    try {
      expect(() => scaffoldProwlDir(tempDir, "ci")).toThrow("destination copy failed");
      expect(fs.existsSync(prowlDir)).toBe(false);
    } finally {
      copySpy.mockRestore();
    }
  });

  it("prints preset-specific post-init hints (ci points at the workflow)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runInit(["--preset", "ci"]);
      const output = logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("github-workflow.example.yml");
      expect(output).toContain(".github/workflows/prowl.yml");
    } finally {
      logSpy.mockRestore();
    }
  });
});
