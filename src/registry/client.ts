import { Code } from '../util/codes.ts'
import { RarnError, RegistryError } from '../util/errors.ts'
import { type PackageName, toWallyName } from '../util/package-name.ts'
import { parseMetadata, parseSearchName } from './parse.ts'
import {
  DEFAULT_API_URL,
  DEFAULT_INDEX_URL,
  type PackageMetadata,
  type RegistryClient,
  type SearchResult,
  WALLY_VERSION_HEADER,
} from './types.ts'

export interface RegistryClientOptions {
  /** Index repository. Only used to discover the API URL. */
  indexUrl?: string
  /** Skips index lookup entirely. Useful for private registries and for tests. */
  apiUrl?: string
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Bearer token for private packages. Public ones need none. */
  token?: string | undefined
  /** Attempts for a retryable failure, including the first. */
  attempts?: number
  /** Base backoff delay; doubles per attempt. */
  retryDelayMs?: number
}

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const indexUrl = options.indexUrl ?? DEFAULT_INDEX_URL
  const attempts = options.attempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 250

  // One metadata request per package per process. Resolution walks the graph and
  // revisits the same names constantly; without this the same response would be
  // fetched once per edge rather than once per package.
  const metadataCache = new Map<string, Promise<PackageMetadata>>()
  let apiUrlPromise: Promise<string> | undefined

  async function apiUrl(): Promise<string> {
    apiUrlPromise ??= resolveApiUrl(indexUrl, options.apiUrl, doFetch)
    return await apiUrlPromise
  }

  async function request(path: string, headers: Record<string, string>): Promise<Response> {
    const base = await apiUrl()
    const url = new URL(path.replace(/^\//, ''), base).toString()

    const allHeaders =
      options.token === undefined
        ? headers
        : { ...headers, Authorization: `Bearer ${options.token}` }

    return await withRetry(url, attempts, retryDelayMs, async () => {
      try {
        return await doFetch(url, { headers: allHeaders })
      } catch (cause) {
        throw new RegistryError({
          code: Code.RegistryUnreachable,
          what: 'Could not reach the registry.',
          where: url,
          how: 'Check your network connection and try again.',
          cause,
        })
      }
    })
  }

  return {
    async getMetadata(name: PackageName): Promise<PackageMetadata> {
      const key = toWallyName(name)
      const cached = metadataCache.get(key)
      if (cached !== undefined) return await cached

      // The promise is cached, not the result, so concurrent callers during
      // resolution share one in-flight request instead of racing.
      const pending = (async () => {
        const response = await request(`v1/package-metadata/${key}`, {})
        await assertOk(response, name)
        return parseMetadata(name, await readJson(response, key))
      })()

      metadataCache.set(key, pending)
      try {
        return await pending
      } catch (error) {
        // A failure must not be cached, or a transient outage would poison the
        // whole run even after the registry recovers.
        metadataCache.delete(key)
        throw error
      }
    },

    async getContents(name: PackageName, version: string): Promise<Uint8Array> {
      const key = toWallyName(name)
      const response = await request(`v1/package-contents/${key}/${version}`, {
        'Wally-Version': WALLY_VERSION_HEADER,
      })
      await assertOk(response, name, version)
      return new Uint8Array(await response.arrayBuffer())
    },

    async search(query: string): Promise<readonly SearchResult[]> {
      const response = await request(`v1/package-search?query=${encodeURIComponent(query)}`, {})
      await assertOk(response)

      const body = await readJson(response, 'package-search')
      if (!Array.isArray(body)) return []

      return body.map((entry) => {
        const row = entry as { versions?: unknown; description?: unknown }
        return {
          name: parseSearchName(entry, 'package-search'),
          versions: Array.isArray(row.versions) ? row.versions.map(String) : [],
          description: typeof row.description === 'string' ? row.description : undefined,
        }
      })
    },
  }
}

/**
 * Resolves the API base URL.
 *
 * The stock index needs no lookup at all — its `config.json` has pointed at
 * `api.wally.run` for the life of the registry, and spending a network round trip
 * on every run to rediscover a constant is not worth it. A custom index does get
 * read, but only over GitHub raw, which is the only layout that can be derived from
 * a repository URL. Anything else has to say where its API is.
 */
async function resolveApiUrl(
  indexUrl: string,
  override: string | undefined,
  doFetch: typeof globalThis.fetch,
): Promise<string> {
  if (override !== undefined) return override
  if (normalizeIndexUrl(indexUrl) === normalizeIndexUrl(DEFAULT_INDEX_URL)) return DEFAULT_API_URL

  const rawUrl = githubRawConfigUrl(indexUrl)
  if (rawUrl === null) {
    throw new RarnError({
      code: Code.ManifestInvalid,
      what: `Rarn cannot work out the API URL for the registry ${indexUrl}.`,
      how: 'Only GitHub-hosted indexes are discovered automatically. Point "registry" at a GitHub repository, or set the API URL explicitly.',
    })
  }

  let response: Response
  try {
    response = await doFetch(rawUrl)
  } catch (cause) {
    throw new RegistryError({
      code: Code.RegistryUnreachable,
      what: 'Could not read the registry index configuration.',
      where: rawUrl,
      how: 'Check your network connection and that the index repository is public.',
      cause,
    })
  }

  if (!response.ok) {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: `The registry index has no readable config.json (HTTP ${response.status}).`,
      where: rawUrl,
      how: 'A Wally index must contain a config.json with an "api" field.',
    })
  }

  const config = (await response.json()) as { api?: unknown }
  if (typeof config.api !== 'string') {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: 'The registry index configuration has no "api" field.',
      where: rawUrl,
      how: 'A Wally index must contain a config.json with an "api" field.',
    })
  }
  return config.api
}

function normalizeIndexUrl(url: string): string {
  return url
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function githubRawConfigUrl(indexUrl: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(indexUrl)
  if (match === null) return null

  // Both groups are non-optional in the pattern, but under noUncheckedIndexedAccess
  // they read as possibly-undefined. Checking rather than asserting: interpolating
  // an undefined here would build a URL containing the literal text "undefined"
  // and produce a confusing 404 instead of a clear failure.
  const [, owner, repo] = match
  if (owner === undefined || repo === undefined) return null
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/config.json`
}

/**
 * Turns a non-OK response into the right error.
 *
 * Two registry behaviours are handled specially because the obvious reading of the
 * status code is wrong:
 *
 * - **A missing package returns 500, not 404.** Verified live: asking for a package
 *   that does not exist yields `500` with `could not open package ... from index`.
 *   Treating that as a server error would mean every typo'd package name burns the
 *   full retry schedule before failing, and then reports the wrong cause.
 * - **426 means the version header was missing**, which is a bug in Rarn rather than
 *   anything the user did, so it says so instead of blaming their project.
 */
async function assertOk(response: Response, name?: PackageName, version?: string): Promise<void> {
  if (response.ok) return

  const subject =
    name === undefined
      ? 'the registry'
      : version === undefined
        ? toWallyName(name)
        : `${toWallyName(name)}@${version}`
  const body = await response.text().catch(() => '')

  if (response.status === 426) {
    throw new RegistryError({
      code: Code.WallyVersionHeaderRejected,
      what: 'The registry rejected Rarn as too old.',
      where: response.url,
      detail: body === '' ? undefined : `  ${body}`,
      how: 'This is a bug in Rarn — the Wally-Version header it sends is no longer accepted. Please report it.',
    })
  }

  if (response.status === 401 || response.status === 403) {
    throw new RegistryError({
      code: Code.RegistryAuthRequired,
      what: `Not authorized to read ${subject}.`,
      where: response.url,
      how: 'This package may be private. Rarn does not support authenticated registries yet.',
    })
  }

  if (isPackageMissing(response.status, body)) {
    throw new RegistryError({
      code: version === undefined ? Code.PackageNotFound : Code.VersionNotFound,
      what: `${subject} does not exist in the registry.`,
      where: response.url,
      how: 'Check the spelling, or search for it with `rarn search`.',
    })
  }

  throw new RegistryError({
    code: Code.RegistryBadResponse,
    what: `The registry returned HTTP ${response.status} for ${subject}.`,
    where: response.url,
    detail: body === '' ? undefined : `  ${body.slice(0, 300)}`,
    how: 'This is usually temporary. Try again in a moment.',
  })
}

/** See `assertOk`: the registry reports an unknown package as 500. */
function isPackageMissing(status: number, body: string): boolean {
  if (status === 404) return true
  return status === 500 && /could not open package|No such file or directory/i.test(body)
}

async function readJson(response: Response, subject: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: `The registry returned unreadable JSON for ${subject}.`,
      where: response.url,
      how: 'This is usually temporary. Try again in a moment.',
      cause,
    })
  }
}

/**
 * Retries only what retrying can fix.
 *
 * A 4xx is the caller's fault and will fail identically forever, so it goes
 * straight through. So does the 500 that really means "no such package" — see
 * `assertOk` — which is why that check lives in `isRetryable` too rather than only
 * at the reporting stage.
 */
async function withRetry(
  url: string,
  attempts: number,
  delayMs: number,
  run: () => Promise<Response>,
): Promise<Response> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await run()
      // The last attempt returns the failed response rather than throwing, so that
      // `assertOk` produces the message instead of a generic retry failure.
      if (response.ok || attempt === attempts || !(await isRetryable(response))) return response
    } catch (error) {
      if (attempt === attempts) throw error
    }

    await sleep(delayMs * 2 ** (attempt - 1))
  }

  // Only reachable when `attempts` is below 1, which no caller does.
  throw new RegistryError({
    code: Code.RegistryUnreachable,
    what: 'The registry did not respond.',
    where: url,
    how: 'Check your network connection and try again.',
  })
}

async function isRetryable(response: Response): Promise<boolean> {
  if (response.status < 500 && response.status !== 429) return false
  if (response.status === 429) return true
  // Reading the body clones first: a retry needs the original response intact.
  const body = await response
    .clone()
    .text()
    .catch(() => '')
  return !isPackageMissing(response.status, body)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
