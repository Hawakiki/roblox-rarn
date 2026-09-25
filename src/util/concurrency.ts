/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Downloads want parallelism, but not unbounded parallelism: firing a hundred
 * requests at the registry at once is how a tool gets rate-limited, and each one
 * holds a full archive in memory while it inflates. Results come back in input
 * order regardless of completion order, so callers can zip them against the input.
 *
 * A rejection is not swallowed — no further work is started, because continuing after a
 * failure only delays the report. But **the work already in flight is waited for before
 * the failure propagates**, and that is not politeness. A caller's cleanup runs in a
 * `finally`; if this returned while workers were still writing, the cleanup would delete
 * a directory that then filled up again behind it. `link` leaves its staging tree behind
 * exactly that way — measured, as a failing test, the day the prune loop became
 * concurrent.
 *
 * **The failure reported is the lowest-indexed one**, not the first to occur in time.
 * Indices are handed out in order, so any item before a failing one either finished or
 * failed itself — which makes the lowest failing index the same on every run, whatever
 * the scheduling did. Callers that sort their input therefore still get the property
 * they sorted for: the same package named first, every time.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const width = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  const failures = new Map<number, unknown>()
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
        failures.set(index, error)
        return
      }
    }
  }

  // Cannot reject: `run` records rather than throws, so this settles every worker.
  await Promise.all(Array.from({ length: width }, run))

  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()))
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
 * How many packages to copy out of the cache at once.
 *
 * The copy is not CPU work and it is not one big transfer — it is thousands of small
 * files, and the cost is per file rather than per byte. On Windows each one pays an
 * open, a write, a close and an on-access virus scan, and none of that is anything the
 * process can be doing while it waits.
 *
 * Measured on 575 real module roots, best of the shapes tried:
 *
 * ```
 *  serial -> 2,184ms    8 -> 1,394ms    16 -> 1,380ms
 * ```
 *
 * Eight rather than sixteen because sixteen buys 14ms and each worker in flight is a
 * whole package's file set being written; the curve is flat past eight, so the extra
 * width is spent for nothing. Verified as I/O overlap rather than a scanner artifact —
 * the same speedup appears with the destination on the scanner's exclusion list
 * (1.46x excluded, 1.48x scanned), which is why it should reproduce on Linux too.
 */
export const PRUNE_CONCURRENCY = 8

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
