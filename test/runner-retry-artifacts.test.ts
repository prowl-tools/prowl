import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/types/index.js";

const mockLaunchBrowser = vi.fn();
const mockCloseBrowser = vi.fn();
const mockCreatePlaywrightDriver = vi.fn();
const mockExecuteSteps = vi.fn();
const mockCaptureFinalScreenshot = vi.fn();
const mockEvaluateAssertions = vi.fn();

vi.mock("../src/browser/controller.js", () => ({
  launchBrowser: (...args: unknown[]) => mockLaunchBrowser(...args),
  closeBrowser: (...args: unknown[]) => mockCloseBrowser(...args),
  createPlaywrightDriver: (...args: unknown[]) => mockCreatePlaywrightDriver(...args)
}));

vi.mock("../src/runner/steps.js", () => ({
  executeSteps: (...args: unknown[]) => mockExecuteSteps(...args),
  captureFinalScreenshot: (...args: unknown[]) => mockCaptureFinalScreenshot(...args)
}));

vi.mock("../src/runner/assertions.js", () => ({
  evaluateAssertions: (...args: unknown[]) => mockEvaluateAssertions(...args)
}));

import { runHunt } from "../src/runner/index.js";

function setupProject(huntName: string, huntYml: string): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-retry-artifacts-"));
  const prowlDir = path.join(project, ".prowl");
  const huntsDir = path.join(prowlDir, "hunts");
  fs.mkdirSync(huntsDir, { recursive: true });
  fs.writeFileSync(path.join(prowlDir, "config.yml"), "target:\n  url: 'http://localhost:3000'\n");
  fs.writeFileSync(path.join(huntsDir, `${huntName}.yml`), huntYml);
  return project;
}

function mockSession() {
  return {
    browser: { close: vi.fn() },
    context: { tracing: { stop: vi.fn() }, close: vi.fn() },
    page: {
      on: vi.fn(),
      url: () => "http://localhost:3000"
    },
    tracePath: undefined
  };
}

function setupBrowserMocks(): void {
  mockLaunchBrowser.mockImplementation(async () => mockSession());
  mockCloseBrowser.mockResolvedValue(undefined);
  mockCreatePlaywrightDriver.mockReturnValue({
    capabilities: new Set(["navigate", "query", "interact", "wait", "screenshot", "evaluate", "response"]),
    onResponse: vi.fn()
  });
  mockCaptureFinalScreenshot.mockResolvedValue(undefined);
  mockEvaluateAssertions.mockResolvedValue([]);
}

describe("runHunt retry artifacts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists retry diagnostics to result.json and summary.md (PROWL-033)", async () => {
    const project = setupProject(
      "retry",
      "retry:\n  maxRetries: 1\n  delay: 0\nsteps:\n  - navigate: '/'\n"
    );
    const cwd = process.cwd();
    setupBrowserMocks();
    let calls = 0;
    mockExecuteSteps.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          results: [
            {
              type: "navigate",
              status: "fail",
              durationMs: 10,
              error: "Element `#start` not [found]"
            }
          ],
          screenshots: [],
          failed: true
        };
      }
      return {
        results: [{ type: "navigate", status: "pass", durationMs: 12 }],
        screenshots: [],
        failed: false
      };
    });

    try {
      process.chdir(project);
      const { result, runDir } = await runHunt({ huntName: "retry" });

      expect(result.status).toBe("pass");
      expect(result.retrySummary).toContain("Passed on attempt 2 of 2");
      expect(result.retryHistory).toHaveLength(2);

      const written = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf-8")) as RunResult;
      expect(written.retrySummary).toBe(result.retrySummary);
      expect(written.retryHistory).toEqual(result.retryHistory);

      const summary = fs.readFileSync(path.join(runDir, "summary.md"), "utf-8");
      expect(summary).toContain("## Retries");
      expect(summary).toContain("Passed on attempt 2 of 2");
      expect(summary).toContain("Element \\`\\#start\\` not \\[found\\]");
    } finally {
      process.chdir(cwd);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
