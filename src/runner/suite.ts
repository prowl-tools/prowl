import path from "node:path";
import { runHunt, type RunOptions } from "./index.js";
import { loadConfig, listHunts, loadHuntTags } from "../config/loader.js";
import { writeCiResult, resolveCiStatus, countCiResults } from "../reporter/ci-summary.js";
import { timestamp } from "../utils/timestamp.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import type { CiFailureCluster, CiFlakyHunt, CiHuntResult, CiResult, CiSkipReason, RunResult } from "../types/index.js";
import { rankFlaky, DEFAULT_FLAKY_THRESHOLD } from "./flaky.js";
import { clusterFailures } from "./clustering.js";
import { extractFailures } from "../backlog/index.js";

export type SkipReason = CiSkipReason;
type SuiteHookResult = void | Promise<void>;

export interface RunSuiteHooks {
  onHuntStart?: (huntName: string) => SuiteHookResult;
  onStep?: RunOptions["onStep"];
  onHuntSuccess?: (huntName: string, result: RunResult, runDir: string) => SuiteHookResult;
  onHuntFailure?: (huntName: string, message: string) => SuiteHookResult;
  onHuntSkipped?: (huntName: string, reason: SkipReason) => SuiteHookResult;
}

export interface RunSuiteOptions {
  configPath?: string;
  urlOverride?: string;
  headed?: boolean;
  slowMo?: number;
  trace?: boolean;
  browser?: RunOptions["browser"];
  channel?: RunOptions["channel"];
  viewport?: string;
  junit?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  parallel?: number;
  /**
   * Stop starting new hunts after the first definitive failure (a hunt that
   * fails after any configured retries are exhausted). In sequential mode no
   * further hunts start; in parallel mode already-in-flight hunts run to
   * completion but no new ones are scheduled. Hunts that never start are
   * recorded as skipped with reason "fail-fast".
   */
  failFast?: boolean;
  hooks?: RunSuiteHooks;
}

export interface RunSuiteResult {
  result: CiResult;
  /** Path to the written ci-result.json, or null when there were no hunts to run. */
  resultPath: string | null;
}

function normalizeTagFilter(tags: string[] | undefined): string[] | undefined {
  const normalized = tags?.map((tag) => tag.trim()).filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function callHook(callback: (() => SuiteHookResult | undefined) | undefined): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch {
    // Presentation hooks must never change suite or hunt outcomes.
  }
}

function safeOnStep(hooks: RunSuiteHooks): RunOptions["onStep"] {
  if (!hooks.onStep) return undefined;
  return (result, step, index) => {
    try {
      hooks.onStep?.(result, step, index);
    } catch {
      // Presentation hooks must never change suite or hunt outcomes.
    }
  };
}

function firstRunFailureMessage(result: RunResult): string | undefined {
  const failedStep = result.steps.find((step) => step.status === "fail" && step.error);
  if (failedStep?.error) return failedStep.error;

  const failedAssertion = result.assertions.find((assertion) => assertion.status === "fail" && assertion.error);
  return failedAssertion?.error;
}

/**
 * Runs every hunt in the project and aggregates a CiResult. Side-effect-free with
 * respect to the console and process exit — callers provide hooks for presentation
 * and inspect the returned status for exit codes.
 */
export async function runSuite(options: RunSuiteOptions = {}): Promise<RunSuiteResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const hooks = options.hooks ?? {};

  const { config, configDir } = loadConfig(options.configPath);
  const hunts = listHunts(configDir);

  if (hunts.length === 0) {
    return {
      result: {
        status: "no-hunts",
        startedAt,
        durationMs: 0,
        totalHunts: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        hunts: []
      },
      resultPath: null
    };
  }

  const includeTags = normalizeTagFilter(options.includeTags);
  const excludeTags = normalizeTagFilter(options.excludeTags);
  const resultsByIndex: Array<CiHuntResult | undefined> = new Array(hunts.length);
  const onStep = safeOnStep(hooks);

  // Phase 1: Tag filtering (always sequential, preserves hunt order)
  const huntsToRun: Array<{ huntName: string; index: number }> = [];
  for (let index = 0; index < hunts.length; index++) {
    const huntName = hunts[index];
    if (includeTags || excludeTags) {
      const tags = loadHuntTags(huntName, configDir);

      if (includeTags && !includeTags.some((t) => tags.includes(t))) {
        await callHook(() => hooks.onHuntSkipped?.(huntName, "include"));
        resultsByIndex[index] = { hunt: huntName, status: "skipped", durationMs: 0, skipReason: "include" };
        continue;
      }
      if (excludeTags && excludeTags.some((t) => tags.includes(t))) {
        await callHook(() => hooks.onHuntSkipped?.(huntName, "exclude"));
        resultsByIndex[index] = { hunt: huntName, status: "skipped", durationMs: 0, skipReason: "exclude" };
        continue;
      }
    }
    huntsToRun.push({ huntName, index });
  }

  // Phase 2: Build a task per hunt to run
  const buildTask = (huntName: string) => async (): Promise<CiHuntResult> => {
    const huntStart = Date.now();
    try {
      await callHook(() => hooks.onHuntStart?.(huntName));

      const { result, runDir } = await runHunt({
        huntName,
        urlOverride: options.urlOverride,
        headed: options.headed,
        slowMo: options.slowMo,
        trace: options.trace,
        browser: options.browser,
        channel: options.channel,
        viewport: options.viewport,
        junit: options.junit,
        configPath: options.configPath,
        onStep
      });

      const error = result.status === "fail" ? firstRunFailureMessage(result) ?? "Run failed" : undefined;
      if (error) {
        await callHook(() => hooks.onHuntFailure?.(huntName, error));
      } else {
        await callHook(() => hooks.onHuntSuccess?.(huntName, result, runDir));
      }

      return {
        hunt: huntName,
        status: result.status,
        durationMs: result.durationMs,
        runDir,
        error
      };
    } catch (error) {
      const durationMs = Date.now() - huntStart;
      const message = error instanceof Error ? error.message : "Run failed";
      await callHook(() => hooks.onHuntFailure?.(huntName, message));
      return {
        hunt: huntName,
        status: "fail",
        durationMs,
        error: message
      };
    }
  };

  // Phase 3: Execute (parallel when requested, otherwise sequential in hunt order)
  const failFast = options.failFast === true;
  const failFastSkip = async (huntName: string): Promise<CiHuntResult> => {
    await callHook(() => hooks.onHuntSkipped?.(huntName, "fail-fast"));
    return { hunt: huntName, status: "skipped", durationMs: 0, skipReason: "fail-fast" };
  };

  const parallel = options.parallel;
  if (parallel !== undefined && parallel > 1) {
    // Standard bail semantics: after the first definitive failure, stop
    // scheduling new hunts but let already-in-flight hunts finish. Tasks never
    // started come back as holes and are recorded as fail-fast skips below.
    let bail = false;
    const tasks = huntsToRun.map((entry) => ({
      ...entry,
      task: async (): Promise<CiHuntResult> => {
        const result = await buildTask(entry.huntName)();
        if (failFast && result.status === "fail") bail = true;
        return result;
      }
    }));
    const parallelResults = await runWithConcurrency(
      tasks.map((entry) => entry.task),
      parallel,
      failFast ? { shouldStop: () => bail } : {}
    );
    for (let i = 0; i < tasks.length; i++) {
      const pr = parallelResults[i];
      const task = tasks[i];
      if (pr === undefined) {
        // Never started because fail-fast bailed out.
        resultsByIndex[task.index] = await failFastSkip(task.huntName);
      } else if (pr.status === "fulfilled") {
        resultsByIndex[task.index] = pr.value;
      } else {
        const message = pr.reason instanceof Error ? pr.reason.message : "Run failed";
        resultsByIndex[task.index] = {
          hunt: task.huntName,
          status: "fail",
          durationMs: 0,
          error: message
        };
      }
    }
  } else {
    let bail = false;
    for (const { huntName, index } of huntsToRun) {
      if (bail) {
        resultsByIndex[index] = await failFastSkip(huntName);
        continue;
      }
      const result = await buildTask(huntName)();
      resultsByIndex[index] = result;
      if (failFast && result.status === "fail") bail = true;
    }
  }

  const totalDurationMs = Date.now() - startTime;
  const results: CiHuntResult[] = resultsByIndex.map((result, index) => {
    return result ?? {
      hunt: hunts[index],
      status: "fail",
      durationMs: 0,
      error: "Run did not produce a result"
    };
  });

  // Flag flaky hunts among those that actually ran this suite, using accumulated
  // run history (which already includes this run's entries). Omitted when none.
  const threshold = config.reliability?.flakyThreshold ?? DEFAULT_FLAKY_THRESHOLD;
  const ranThisSuite = new Set(
    results.filter((r) => r.status !== "skipped").map((r) => r.hunt)
  );
  const flaky: CiFlakyHunt[] = rankFlaky(configDir, { threshold })
    .filter((entry) => entry.flaky && ranThisSuite.has(entry.hunt))
    .map((entry) => ({ hunt: entry.hunt, score: entry.score }));

  // Cluster failures from this suite by shared cause; surface only multi-hunt
  // clusters (a single failing hunt is just that failure, not a "cluster").
  const clusters: CiFailureCluster[] = clusterFailures(
    extractFailures({ result: { hunts: results } as CiResult, resultPath: null })
  ).filter((cluster) => cluster.count > 1);

  const ciRunDir = path.join(configDir, "runs", timestamp("ci"));
  const resultPath = writeCiResult(ciRunDir, results, startedAt, totalDurationMs, flaky, clusters);

  const { passed, failed, skipped } = countCiResults(results);

  return {
    result: {
      status: resolveCiStatus(results),
      startedAt,
      durationMs: totalDurationMs,
      totalHunts: results.length,
      passed,
      failed,
      skipped,
      hunts: results,
      ...(flaky.length > 0 ? { flaky } : {}),
      ...(clusters.length > 0 ? { clusters } : {})
    },
    resultPath
  };
}
