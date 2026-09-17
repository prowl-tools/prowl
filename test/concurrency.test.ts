import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/utils/concurrency.js";

describe("runWithConcurrency", () => {
  it("runs tasks sequentially with concurrency=1", async () => {
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      order.push(i);
      return i;
    });

    const results = await runWithConcurrency(tasks, 1);

    expect(order).toEqual([0, 1, 2]);
    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 }
    ]);
  });

  it("runs up to N tasks concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return i;
    });

    const results = await runWithConcurrency(tasks, 3);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(results).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(results[i]).toEqual({ status: "fulfilled", value: i });
    }
  });

  it("captures errors as rejected results", async () => {
    const tasks = [
      async () => "ok",
      async () => { throw new Error("boom"); },
      async () => "also ok"
    ];

    const results = await runWithConcurrency(tasks, 2);

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as { status: "rejected"; reason: Error }).reason.message).toBe("boom");
    expect(results[2]).toEqual({ status: "fulfilled", value: "also ok" });
  });

  it("preserves original order of results", async () => {
    const tasks = [
      async () => { await new Promise((r) => setTimeout(r, 30)); return "slow"; },
      async () => { return "fast"; },
      async () => { await new Promise((r) => setTimeout(r, 10)); return "medium"; }
    ];

    const results = await runWithConcurrency(tasks, 3);

    expect(results[0]).toEqual({ status: "fulfilled", value: "slow" });
    expect(results[1]).toEqual({ status: "fulfilled", value: "fast" });
    expect(results[2]).toEqual({ status: "fulfilled", value: "medium" });
  });

  it("handles empty task list", async () => {
    const results = await runWithConcurrency([], 3);
    expect(results).toEqual([]);
  });

  it("stops starting new tasks once shouldStop trips, leaving unstarted holes", async () => {
    const started: number[] = [];
    let stop = false;
    const tasks = [0, 1, 2, 3, 4].map((i) => async () => {
      started.push(i);
      // Trip the bail after the first task runs.
      if (i === 0) stop = true;
      return i;
    });

    const results = await runWithConcurrency(tasks, 1, { shouldStop: () => stop });

    // With concurrency=1 and bail after task 0, no further tasks start.
    expect(started).toEqual([0]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1]).toBeUndefined();
    expect(results[4]).toBeUndefined();
  });

  it("lets in-flight tasks finish when shouldStop trips mid-flight", async () => {
    const finished: number[] = [];
    let stop = false;
    const tasks = [
      async () => { await new Promise((r) => setTimeout(r, 10)); stop = true; finished.push(0); return 0; },
      async () => { await new Promise((r) => setTimeout(r, 20)); finished.push(1); return 1; },
      async () => { finished.push(2); return 2; }
    ];

    const results = await runWithConcurrency(tasks, 2, { shouldStop: () => stop });

    // Tasks 0 and 1 start together (concurrency 2); task 0 trips the bail before
    // either worker frees up, so task 2 never starts.
    expect(finished.sort()).toEqual([0, 1]);
    expect(results[2]).toBeUndefined();
  });

  it("normalizes non-positive concurrency to 1", async () => {
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      order.push(i);
      return i;
    });

    const results = await runWithConcurrency(tasks, 0);

    expect(order).toEqual([0, 1, 2]);
    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 }
    ]);
  });
});
