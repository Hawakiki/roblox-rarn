/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Downloads want parallelism, but not unbounded parallelism: firing a hundred
 * requests at the registry at once is how a tool gets rate-limited, and each one
 * holds a full archive in memory while it inflates. Results come back in input
 * order regardless of completion order, so callers can zip them against the input.
 *
 * A rejection is not swallowed — the first one propagates, and no further work is
 * started, because continuing to download after a failure only delays the report.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const width = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false

  const run = async (): Promise<void> => {
    while (!failed) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      try {
        results[index] = await worker(item, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }

  await Promise.all(Array.from({ length: width }, run))
  return results
}

/**
 * How many downloads to run at once.
 *
 * Eight is a deliberate middle: enough that latency overlaps on a shallow graph,
 * low enough that a dozen large packages do not sit inflating in memory together.
 */
export const DEFAULT_CONCURRENCY = 8
