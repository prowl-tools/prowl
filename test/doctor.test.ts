import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/types/index.js";
import type { MacdriverStatus } from "../src/browser/macdriver-install.js";
import {
  checkNode,
  checkPlaywright,
  checkChromium,
  checkProwlDir,
  checkConfig,
  checkMacTarget,
  checkIosTarget,
  checkAndroidTarget,
  runDoctorChecks,
  runDoctor,
  CHECK_NODE,
  CHECK_CHROMIUM,
  CHECK_PROWL_DIR,
  CHECK_CONFIG,
  CHECK_MACOS,
  CHECK_IOS,
  CHECK_ANDROID,
  INSTALL_CHROMIUM_TIMEOUT_MS,
  defaultDoctorDeps,
  playwrightInstallChromiumCommand,
  resolvePlaywrightCliPath,
  type DoctorDeps,
  type PlaywrightProbeResult
} from "../src/doctor/checks.js";
import { buildDoctorCommand } from "../src/cli/commands/doctor.js";
import { buildProgram } from "../src/cli/program.js";

function webConfig(type: Config["target"]["type"] = "web"): { config: Config } {
  const target =
    type === "web"
      ? { type: "web", url: "http://localhost:3000" }
      : type === "macos"
        ? { type: "macos", app: "Notes" }
        : type === "ios"
          ? { type: "ios", app: "com.example.app" }
          : { type: "android", app: "com.example.app" };
  return { config: { target } as Config };
}

function healthyProbe(): PlaywrightProbeResult {
  return { playwrightInstalled: true, chromiumPath: "/browsers/chromium", chromiumInstalled: true };
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "20.11.0",
    platform: "darwin",
    cwd: "/project",
    env: {},
    probePlaywright: async () => healthyProbe(),
    runCommand: async () => ({ stdout: "" }),
    prowlDirExists: () => true,
    loadConfig: () => webConfig("web"),
    collectMacdriverStatus: async () => ({
      resolved: { path: "/bin/prowl-macdriver", source: "user-install" },
      pinnedVersion: "0.1.0",
      installed: [],
      probedVersion: "0.1.0"
    }),
    installChromium: async () => {},
    scaffoldProwlDir: () => {},
    ...overrides
  };
}

describe("individual doctor checks", () => {
  it("passes Node >= 20 and fails older versions", () => {
    expect(checkNode("20.0.0").status).toBe("pass");
    expect(checkNode("22.21.1").status).toBe("pass");
    const old = checkNode("18.19.0");
    expect(old.status).toBe("fail");
    expect(old.fixable).toBe(false);
    expect(old.message).toContain(">= 20");
  });

  it("reports Playwright install state", () => {
    expect(checkPlaywright(healthyProbe()).status).toBe("pass");
    const missing = checkPlaywright({ playwrightInstalled: false, chromiumPath: null, chromiumInstalled: false });
    expect(missing.status).toBe("fail");
  });

  it("marks Chromium fixable when missing and skips when Playwright is absent", () => {
    expect(checkChromium(healthyProbe()).status).toBe("pass");

    const missing = checkChromium({ playwrightInstalled: true, chromiumPath: "/x", chromiumInstalled: false });
    expect(missing.status).toBe("fail");
    expect(missing.fixable).toBe(true);
    expect(missing.message).toContain("playwright install chromium");

    const noPw = checkChromium({ playwrightInstalled: false, chromiumPath: null, chromiumInstalled: false });
    expect(noPw.status).toBe("skip");
  });

  it("warns (fixable) when .prowl/ is missing", () => {
    expect(checkProwlDir(true).status).toBe("pass");
    const warn = checkProwlDir(false);
    expect(warn.status).toBe("warn");
    expect(warn.fixable).toBe(true);
  });

  it("skips config when no .prowl/, passes on valid, fails on load error", () => {
    const skipped = checkConfig(false, () => webConfig("web"));
    expect(skipped.result.status).toBe("skip");
    expect(skipped.config).toBeNull();

    const ok = checkConfig(true, () => webConfig("macos"));
    expect(ok.result.status).toBe("pass");
    expect(ok.result.message).toContain("macos");
    expect(ok.config?.target.type).toBe("macos");

    const bad = checkConfig(true, () => {
      throw new Error("bad yaml at line 3");
    });
    expect(bad.result.status).toBe("fail");
    expect(bad.result.message).toContain("bad yaml at line 3");
    expect(bad.config).toBeNull();
  });
});

describe("target-aware checks", () => {
  it("passes the macOS check when a helper resolves and fails when none does", async () => {
    const resolved: MacdriverStatus = {
      resolved: { path: "/bin/prowl-macdriver", source: "user-install" },
      pinnedVersion: "0.1.0",
      installed: [],
      probedVersion: "0.1.0"
    };
    const pass = await checkMacTarget(async () => resolved, {});
    expect(pass.status).toBe("pass");
    expect(pass.message).toContain("/bin/prowl-macdriver");
    expect(pass.message).toContain("reports 0.1.0");

    const none: MacdriverStatus = { resolved: null, pinnedVersion: "0.1.0", installed: [], probedVersion: null };
    const fail = await checkMacTarget(async () => none, {});
    expect(fail.status).toBe("fail");
    expect(fail.message).toContain("prowl macdriver install");
  });

  it("fails the macOS check when status collection or version probing fails", async () => {
    const rejected = await checkMacTarget(async () => {
      throw new Error("probe crashed");
    }, {});
    expect(rejected.status).toBe("fail");
    expect(rejected.message).toContain("probe crashed");
    expect(rejected.message).toContain("prowl macdriver status");

    const unprobed: MacdriverStatus = {
      resolved: { path: "/bin/prowl-macdriver", source: "user-install" },
      pinnedVersion: "0.1.0",
      installed: [],
      probedVersion: null
    };
    const failedProbe = await checkMacTarget(async () => unprobed, {});
    expect(failedProbe.status).toBe("fail");
    expect(failedProbe.message).toContain("version probe failed");
    expect(failedProbe.message).toContain("prowl macdriver status");
  });

  it("fails the iOS check off macOS and probes simctl on macOS", async () => {
    const offMac = await checkIosTarget("linux", async () => ({ stdout: "" }));
    expect(offMac.status).toBe("fail");
    expect(offMac.message).toContain("requires macOS");

    const ok = await checkIosTarget("darwin", async () => ({ stdout: "help" }));
    expect(ok.status).toBe("pass");

    const missing = await checkIosTarget("darwin", async () => {
      throw new Error("xcrun: not found");
    });
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("xcode-select");
  });

  it("probes adb for the Android check", async () => {
    const ok = await checkAndroidTarget(async () => ({ stdout: "Android Debug Bridge" }));
    expect(ok.status).toBe("pass");

    const missing = await checkAndroidTarget(async () => {
      throw new Error("adb: command not found");
    });
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("platform-tools");
  });
});

describe("runDoctorChecks target routing", () => {
  it("runs no target check for the web target", async () => {
    const results = await runDoctorChecks(makeDeps({ loadConfig: () => webConfig("web") }));
    const names = results.map((r) => r.name);
    expect(names).toContain(CHECK_NODE);
    expect(names).toContain(CHECK_CONFIG);
    expect(names).not.toContain(CHECK_MACOS);
    expect(names).not.toContain(CHECK_IOS);
    expect(names).not.toContain(CHECK_ANDROID);
  });

  it("adds only the macOS check for a macOS target", async () => {
    const results = await runDoctorChecks(makeDeps({ loadConfig: () => webConfig("macos") }));
    const names = results.map((r) => r.name);
    expect(names).toContain(CHECK_MACOS);
    expect(names).not.toContain(CHECK_ANDROID);
  });

  it("adds the Android check for an Android target", async () => {
    const results = await runDoctorChecks(makeDeps({ loadConfig: () => webConfig("android") }));
    expect(results.map((r) => r.name)).toContain(CHECK_ANDROID);
  });

  it("skips target checks when the config is invalid", async () => {
    const results = await runDoctorChecks(
      makeDeps({
        loadConfig: () => {
          throw new Error("nope");
        }
      })
    );
    const config = results.find((r) => r.name === CHECK_CONFIG);
    expect(config?.status).toBe("fail");
    expect(results.map((r) => r.name)).not.toContain(CHECK_MACOS);
  });
});

describe("runDoctor and --fix", () => {
  it("reports ok when nothing fails (warnings are acceptable)", async () => {
    const report = await runDoctor(makeDeps({ prowlDirExists: () => false }));
    expect(report.ok).toBe(true);
    expect(report.results.find((r) => r.name === CHECK_PROWL_DIR)?.status).toBe("warn");
  });

  it("reports not-ok when a check fails", async () => {
    const report = await runDoctor(makeDeps({ nodeVersion: "18.0.0" }));
    expect(report.ok).toBe(false);
  });

  it("installs Chromium on --fix and re-runs to a pass", async () => {
    let installed = false;
    const probe = (): PlaywrightProbeResult =>
      installed
        ? { playwrightInstalled: true, chromiumPath: "/x", chromiumInstalled: true }
        : { playwrightInstalled: true, chromiumPath: "/x", chromiumInstalled: false };

    const report = await runDoctor(
      makeDeps({
        probePlaywright: async () => probe(),
        installChromium: async () => {
          installed = true;
        }
      }),
      { fix: true }
    );

    expect(report.fixes.map((f) => f.name)).toContain(CHECK_CHROMIUM);
    expect(report.results.find((r) => r.name === CHECK_CHROMIUM)?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("scaffolds .prowl/ on --fix through the injected scaffolder", async () => {
    let scaffolded = false;
    const report = await runDoctor(
      makeDeps({
        prowlDirExists: () => scaffolded,
        scaffoldProwlDir: () => {
          scaffolded = true;
        }
      }),
      { fix: true }
    );

    expect(report.fixes.map((f) => f.name)).toContain(CHECK_PROWL_DIR);
    expect(report.results.find((r) => r.name === CHECK_PROWL_DIR)?.status).toBe("pass");
  });

  it("captures a fix error without throwing", async () => {
    const report = await runDoctor(
      makeDeps({
        probePlaywright: async () => ({ playwrightInstalled: true, chromiumPath: "/x", chromiumInstalled: false }),
        installChromium: async () => {
          throw new Error("network down");
        }
      }),
      { fix: true }
    );

    const fix = report.fixes.find((f) => f.name === CHECK_CHROMIUM);
    expect(fix?.error).toContain("network down");
    // Chromium still missing after a failed fix.
    expect(report.results.find((r) => r.name === CHECK_CHROMIUM)?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("does not attempt fixes for non-fixable failures", async () => {
    const installChromium = vi.fn(async () => {});
    const scaffoldProwlDir = vi.fn(() => {});
    const report = await runDoctor(
      makeDeps({ nodeVersion: "18.0.0", installChromium, scaffoldProwlDir }),
      { fix: true }
    );
    expect(installChromium).not.toHaveBeenCalled();
    expect(scaffoldProwlDir).not.toHaveBeenCalled();
    expect(report.fixes).toEqual([]);
  });
});

describe("default doctor dependencies", () => {
  it("checks only the current directory for .prowl/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-doctor-"));
    try {
      const child = path.join(root, "child");
      fs.mkdirSync(path.join(root, ".prowl"));
      fs.mkdirSync(child);

      const deps = defaultDoctorDeps();
      expect(deps.prowlDirExists(root)).toBe(true);
      expect(deps.prowlDirExists(child)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the Chromium install command from Prowl's resolved Playwright dependency", () => {
    const command = playwrightInstallChromiumCommand();

    expect(command.file).toBe(process.execPath);
    expect(command.args).toEqual([resolvePlaywrightCliPath(), "install", "chromium"]);
    expect(command.args[0]).toContain(path.join("node_modules", "playwright", "cli.js"));
    expect(fs.existsSync(command.args[0])).toBe(true);
    expect(INSTALL_CHROMIUM_TIMEOUT_MS).toBe(300000);
  });
});

describe("doctor command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function stdout(): string {
    return logSpy.mock.calls.flat().join("\n");
  }

  it("is registered on the root program", () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toContain("doctor");
  });

  it("prints the summary and leaves the exit code unset when healthy", async () => {
    await buildDoctorCommand(makeDeps()).parseAsync(["node", "prowl", "doctor"]);
    expect(stdout()).toContain("Environment is healthy");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the warning summary and leaves the exit code unset when only warnings remain", async () => {
    await buildDoctorCommand(makeDeps({ prowlDirExists: () => false })).parseAsync(["node", "prowl", "doctor"]);
    expect(stdout()).toContain("Environment is usable, with warnings");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code 1 when a check fails", async () => {
    await buildDoctorCommand(makeDeps({ nodeVersion: "18.0.0" })).parseAsync(["node", "prowl", "doctor"]);
    expect(stdout()).toContain("Environment has problems");
    expect(process.exitCode).toBe(1);
  });

  it("reports attempted fixes under --fix", async () => {
    let scaffolded = false;
    await buildDoctorCommand(
      makeDeps({
        prowlDirExists: () => scaffolded,
        scaffoldProwlDir: () => {
          scaffolded = true;
        }
      })
    ).parseAsync(["node", "prowl", "doctor", "--fix"]);
    expect(stdout()).toContain("Attempted fixes");
  });

  it("sets exit code 1 when the run throws", async () => {
    await buildDoctorCommand(
      makeDeps({
        probePlaywright: async () => {
          throw new Error("boom");
        }
      })
    ).parseAsync(["node", "prowl", "doctor"]);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Error: boom");
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Re-run `prowl doctor`; if it fails again, report the error.");
    expect(process.exitCode).toBe(1);
  });
});
