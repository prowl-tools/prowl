import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildInitCommand, scaffoldProwlDir } from "../src/cli/commands/init.js";
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

  function failDestinationHuntCopies(prowlDir: string) {
    const copyFileSync = fs.copyFileSync;
    return vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (String(destination).startsWith(path.join(prowlDir, "hunts") + path.sep)) {
        throw new Error("destination copy failed");
      }
      copyFileSync(source, destination, mode);
    });
  }

  it("creates .prowl directory with config, example hunt, and .gitignore", () => {
    runInit();

    const prowlDir = path.join(tempDir, ".prowl");
    expect(fs.existsSync(path.join(prowlDir, "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "hello.yml"))).toBe(true);
    expect(fs.existsSync(path.join(prowlDir, "hunts", "login-flow.yml"))).toBe(true);
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
