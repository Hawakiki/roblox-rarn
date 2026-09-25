import type { RegistryClient } from '../registry/types.ts'
import type { ResolvedPackage } from '../resolver/types.ts'
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../util/concurrency.ts'
import { byCodeUnit } from '../util/order.ts'
import type { CacheStore, CachedPackage } from './store.ts'

export interface FetchedPackage extends CachedPackage {
  /** Lockfile key, `@scope/name@version`. */
  readonly key: string
  readonly resolved: ResolvedPackage
}

export interface FetchOptions {
  packages: ReadonlyMap<string, ResolvedPackage>
  registry: RegistryClient
  store: CacheStore
  /** Recorded digests from `rarn.lock`, keyed the same way. */
  expectedIntegrity?: ReadonlyMap<string, string>
  concurrency?: number
  /** Called as each package settles, for progress output. */
  onProgress?: (fetched: FetchedPackage, done: number, total: number) => void
}

export interface FetchSummary {
  readonly packages: readonly FetchedPackage[]
  /** How many were already cached — the number that made the install fast. */
  readonly cached: number
  readonly downloaded: number
}

/**
 * Materializes every resolved package into the cache.
 *
 * Downloads only start once resolution has settled, which is the reason resolution
 * was built to work from metadata alone: nothing is transferred for a version that
 * turns out not to be selected.
 */
export async function fetchPackages(options: FetchOptions): Promise<FetchSummary> {
  const { packages, registry, store, expectedIntegrity, onProgress } = options
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  // Sorted so progress output and any resulting error are in a stable order; the
  // work itself is order-independent.
  const entries = [...packages.entries()].sort(([a], [b]) => byCodeUnit(a, b))
  let done = 0

  const fetched = await mapWithConcurrency(entries, concurrency, async ([key, resolved]) => {
    const cached = await store.ensure(
      resolved.name,
      resolved.version,
      () => registry.getContents(resolved.name, resolved.version),
      expectedIntegrity?.get(key),
    )

    const result: FetchedPackage = { ...cached, key, resolved }
    done += 1
    onProgress?.(result, done, entries.length)
    return result
  })

  return {
    packages: fetched,
    cached: fetched.filter((f) => f.fromCache).length,
    downloaded: fetched.filter((f) => !f.fromCache).length,
  }
}
