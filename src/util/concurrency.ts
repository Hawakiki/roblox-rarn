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

/**
 * How many metadata requests to run at once.
 *
 * Higher than the download limit because the bodies are small JSON and nothing is
 * held in memory afterwards — the cost being overlapped is latency, not bytes.
 *
 * Measured against the live registry, 150 packages, best of two runs:
 *
 * ```
 *  8 -> 5.0s    16 -> 2.8s    32 -> 1.8s    64 -> 7.4s    unbounded(150) -> 21.9s
 * ```
 *
 * The curve turns hard after 32, and unbounded is twelve times slower than the
 * best — which is what `fetchMissing` used to do. A graph with 506 direct
 * dependencies opened 506 sockets at once and spent 43s where 5s was available.
 */
export const METADATA_CONCURRENCY = 32

/**
 * How many small local files to read at once.
 *
 * Not a network limit: these are entry modules already on disk, read to find the type
 * aliases a shim forwards. Doing them in turn inside the install loop cost 225ms on a
 * 52-package project — Windows charges real latency per open, and none of these reads
 * depends on another.
 *
 * Higher than the download limit because nothing is held afterwards; bounded at all
 * because a 506-package graph should not open 506 handles to save microseconds.
 */
export const FILE_READ_CONCURRENCY = 32
