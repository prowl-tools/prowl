export type ConcurrencyResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export interface RunWithConcurrencyOptions {
  /**
   * Cooperative bail-out predicate. Checked before a worker picks up its next
   * task; when it returns true, no further tasks are started. Tasks already in
   * flight are never interrupted — they run to completion. Indices that were
   * never started are left as holes (undefined) in the returned array.
   */
  shouldStop?: () => boolean;
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  options: RunWithConcurrencyOptions = {}
): Promise<Array<ConcurrencyResult<T>>> {
  const normalizedConcurrency =
    Number.isFinite(concurrency) && concurrency > 0
      ? Math.floor(concurrency)
      : 1;
  const results: Array<ConcurrencyResult<T>> = new Array(tasks.length);
  let nextIndex = 0;
  const shouldStop = options.shouldStop;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (shouldStop?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        const value = await tasks[index]();
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(normalizedConcurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
