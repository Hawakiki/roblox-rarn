import { Code } from '../util/codes.ts'
import { RarnError, RegistryError } from '../util/errors.ts'
import {
  type Fetch,
  createFetch,
  isNetworkBlocked,
  isNetworkTimeout,
  readFully,
} from '../util/network.ts'
import { type PackageName, toWallyName } from '../util/package-name.ts'
import { parseMetadata, parseSearchName } from './parse.ts'
import {
  DEFAULT_API_URL,
  DEFAULT_INDEX_URL,
  type PackageMetadata,
  type PublishReceipt,
  type RegistryClient,
  type SearchResult,
  WALLY_VERSION_HEADER,
} from './types.ts'

export interface RegistryClientOptions {
  /** Index repository. Only used to discover the API URL. */
  indexUrl?: string
  /** Skips index lookup entirely. Useful for private registries and for tests. */
  apiUrl?: string
  /** Injected for tests; defaults to the real network, guarded. */
  fetch?: Fetch
  /** Bearer token for private packages. Public ones need none. */
  token?: string | undefined
  /** Attempts for a retryable failure, including the first. */
  attempts?: number
  /** Base backoff delay; doubles per attempt. */
  retryDelayMs?: number
  /** Overrides for tests; the defaults and their reasons live in `util/network.ts`. */
  responseTimeoutMs?: number
  idleTimeoutMs?: number
  /** Override for tests; the default and its reason are `UPLOAD_TIMEOUT_MS` below. */
  uploadTimeoutMs?: number
}

/**
 * How long a publish may wait for the registry to answer.
 *
 * Far longer than an ordinary request, because this clock also covers the upload:
 * fetch reports no upload progress, so a slow line still sending cannot be told from a
 * dead one until the response starts. Four minutes carries the registry's 2 MiB ceiling
 * at under 9 KB/s. Being cut off early is the expensive mistake here — it leaves the
 * outcome unknown — so this errs long, but stays under Bun's own 300s limit: that one
 * fails with a bare DOMException, which carries nothing to recognise it by and would
 * reach the reader as a dropped connection rather than as the timeout it was.
 */
const UPLOAD_TIMEOUT_MS = 240_000

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const doFetch = createFetch({
    fetch: options.fetch,
    responseTimeoutMs: options.responseTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
  })
  const uploadFetch = createFetch({
    fetch: options.fetch,
    responseTimeoutMs: options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs,
  })
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
        return await readFully(await doFetch(url, { headers: allHeaders }))
      } catch (cause) {
        // A structured failure already knows what went wrong — the offline guard,
        // a timeout, or an injected fetch in a test. Wrapping it as "could not reach
        // the registry" would replace an accurate diagnosis with a guess.
        if (cause instanceof RarnError) throw cause
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

    async apiBase(): Promise<string> {
      return await apiUrl()
    },

    /**
     * Uploads the archive.
     *
     * Deliberately not retried, unlike every other call here. The others are
     * idempotent reads; this one is a write whose outcome after a timeout is
     * genuinely unknown, and a retry that succeeds where the first attempt also
     * succeeded is a second publish. The registry would answer 409 in that case,
     * which is safe but reports a failure for something that worked — worse to
     * read than one clear error.
     */
    async publish(archive: Uint8Array, token: string, spec: string): Promise<PublishReceipt> {
      const base = await apiUrl()
      const url = new URL('v1/publish', base).toString()

      let response: Response
      try {
        response = await uploadFetch(url, {
          method: 'POST',
          headers: {
            'Wally-Version': WALLY_VERSION_HEADER,
            Authorization: `Bearer ${token}`,
            accept: 'application/json',
            'content-type': 'application/octet-stream',
          },
          body: archive,
        })
      } catch (cause) {
        if (isNetworkTimeout(cause)) {
          throw publishOutcomeUnknown({
            code: Code.NetworkTimeout,
            what: 'the registry stopped responding during the upload.',
            url,
            spec,
            cause,
          })
        }
        // The offline guard's refusal, made before anything is sent.
        if (cause instanceof RarnError) throw cause
        if (neverConnected(cause)) {
          // Bun's own wording is the only place a refused certificate is named, so it is
          // passed through — minus the advice Bun appends for whoever wrote the request
          // call, which someone running a binary has no way to follow.
          const message =
            cause instanceof Error ? cause.message.replace(BUN_FETCH_HINT, '').trim() : ''
          throw new RegistryError({
            code: Code.RegistryUnreachable,
            what: 'Could not reach the registry to publish.',
            where: url,
            detail: message === '' ? undefined : `  ${message}`,
            how: 'Nothing was published. Check your connection and try again.',
            cause,
          })
        }
        throw publishOutcomeUnknown({
          code: Code.RegistryUnreachable,
          what: 'the connection to the registry closed before it answered.',
          url,
          spec,
          cause,
        })
      }

      // The status already says whether it was published; the body is only the
      // registry's wording. Failing on it would report a publish that worked as one
      // that did not.
      const body = (await response.text().catch(() => '')).trim()
      if (response.ok) {
        return { status: response.status, message: body === '' ? undefined : body }
      }
      throw publishFailure(response.status, body, url, spec)
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
  doFetch: Fetch,
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
    if (cause instanceof RarnError) throw cause
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
      // A refusal to go out is not a transport failure. Retrying it burns the
      // whole backoff schedule to arrive at the same answer, which in CI turns one
      // clear message into a slow one.
      if (attempt === attempts || isNetworkBlocked(error)) throw error
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

/**
 * A publish that may or may not have happened, and the message has to say so.
 *
 * "Nothing was published" is the natural wording and the wrong one: the registry
 * (`wally-registry-backend`, its `publish` handler) stores the archive and commits the
 * version to its index, and only then recrawls the whole index for search before it
 * answers. That last step is the slow one, so a publish that runs long is usually past
 * the point of no return when the answer fails to arrive — and a published version is
 * permanent. A reader told nothing happened believes nothing is public, or publishes
 * again and meets RN0622 over something that worked.
 */
function publishOutcomeUnknown(failure: {
  code: Code
  what: string
  url: string
  spec: string
  body?: string
  cause?: unknown
}): RegistryError {
  // A gateway's answer is often a whole HTML page; the first of it is enough to search.
  const said =
    failure.body === undefined || failure.body === '' ? [] : [`  ${failure.body.slice(0, 300)}`]
  return new RegistryError({
    code: failure.code,
    what: failure.what,
    where: failure.url,
    detail: [
      ...said,
      '  The package may have been published anyway — there is no way to tell from here.',
    ].join('\n'),
    how: `Check before publishing again: \`rarn info ${failure.spec}\` lists the version if it went through. If it is not there, publish again — a repeat of one that did go through is refused (RN0622), never published twice.`,
    cause: failure.cause,
  })
}

/**
 * The rejection codes that prove a request never reached the registry.
 *
 * Measured on Bun 1.3.14 against local servers counting what they received, 20 runs
 * each with a 64 KiB upload. A closed port, a host name that does not resolve and a peer
 * that does not speak TLS reject with `ConnectionRefused`. A certificate the client
 * refuses rejects with a code of its own; the server saw the handshake complete and not
 * one byte of the request, because Bun checks the certificate before it sends anything.
 * `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` is a peer that closed after the ClientHello,
 * so no session ever existed to send through.
 *
 * The first four certificate codes are the chains a TLS-intercepting proxy presents.
 * Read as possibly delivered, they would send the reader to `rarn info`, which fails on
 * the same certificate.
 *
 * Everything unlisted is read as possibly delivered — `ECONNRESET` above all, which Bun
 * reports both for a peer that closed on accept and for one that read the whole upload
 * and then dropped the connection. A failure after the upload arrived was measured too
 * (reset, close, half a response, garbage): each gave `ECONNRESET` or
 * `Malformed_HTTP_Response`, never a code listed here. A code missing here costs one
 * needless `rarn info`; a code wrongly here tells someone nothing was published when it
 * was.
 */
const NEVER_CONNECTED = new Set([
  'ConnectionRefused',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR',
])

/** Measured on Bun 1.3.14, appended to `ERR_TLS_CERT_ALTNAME_INVALID` and similar. */
const BUN_FETCH_HINT =
  /\.?\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?\s*$/

function neverConnected(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const { code } = cause as { code?: unknown }
  return typeof code === 'string' && NEVER_CONNECTED.has(code)
}

/**
 * Turns a publish rejection into something actionable.
 *
 * Every one of these has a different fix, and the raw status alone sends the reader
 * to the wrong one — 401 in particular reads as "log in again" when it usually means
 * the scope belongs to somebody else.
 *
 * The line between "nothing was published" and "it may have been" is 500. Every 4xx
 * the registry sends is a refusal made before the archive is stored. A 5xx is not a
 * judgement at all: the backend reports any failure it did not anticipate as 500,
 * including one from the index recrawl that runs after the version is committed, and a
 * gateway in front of it answers 502 or 504 when it gives up on a request the backend
 * may still finish. 504 is the timeout the client would have hit itself, so it is
 * reported as one.
 */
function publishFailure(status: number, body: string, url: string, spec: string): RarnError {
  const detail = body === '' ? undefined : `  ${body}`

  if (status === 409) {
    return new RarnError({
      code: Code.VersionAlreadyPublished,
      what: 'that version is already published.',
      where: url,
      detail,
      how: 'Registry versions are immutable. Raise the version in rarn.json and publish again.',
    })
  }
  if (status === 401 || status === 403) {
    return new RarnError({
      code: Code.PublishForbidden,
      what: 'the registry refused this scope.',
      where: url,
      detail,
      how: 'Check that your GitHub account owns the scope. Run `rarn whoami` to see who you are.',
    })
  }
  if (status === 400) {
    return new RarnError({
      code: Code.PublishRejected,
      what: 'the registry rejected the package.',
      where: url,
      detail,
      how: 'Run `rarn pack --list` to see exactly what would be uploaded.',
    })
  }
  if (status === 504) {
    return publishOutcomeUnknown({
      code: Code.NetworkTimeout,
      what: 'the registry timed out before answering (504).',
      url,
      spec,
      body,
    })
  }
  if (status >= 500) {
    return publishOutcomeUnknown({
      code: Code.PublishRejected,
      what: `the registry answered ${status}.`,
      url,
      spec,
      body,
    })
  }
  return new RegistryError({
    code: Code.PublishRejected,
    what: `the registry answered ${status}.`,
    where: url,
    detail,
    how: 'Nothing was published. Try again in a moment.',
  })
}
