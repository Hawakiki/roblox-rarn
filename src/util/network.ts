import { Code } from './codes.ts'
import { RarnError, RegistryError } from './errors.ts'

/**
 * Set to anything other than `0` to forbid every outbound request Rarn makes.
 *
 * CI sets it. The test suite is offline by construction — every test injects its
 * own fetch — but that is a convention, and a convention is enforced by whoever
 * remembers it. One test that calls the real registry would pass locally, pass in
 * review, and only show up later as a CI run that fails whenever api.wally.run is
 * having a bad day. With this set, that test fails immediately and says why.
 */
export const NO_NETWORK_ENV = 'RARN_NO_NETWORK'

/**
 * `0` and the empty string mean off, anything else means on.
 *
 * Unlike `NO_COLOR`, which is on when merely present, this reads its value —
 * `RARN_NO_NETWORK=0` in a CI job that needs one online step has to be able to
 * turn the block back off, and unsetting a variable is not always available where
 * setting one is.
 */
export function networkBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  if (byFlag) return true
  const value = env[NO_NETWORK_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

/**
 * Whether `--offline` was passed, as opposed to the environment variable.
 *
 * Tracked separately only so the error can name the thing the reader actually did.
 * "Unset RARN_NO_NETWORK" is unhelpful advice to someone who typed `--offline`, and
 * being told to change something they never set is how a reader concludes the tool
 * has misdiagnosed them and stops reading the rest of the message.
 */
let byFlag = false

export function blockNetwork(): void {
  byFlag = true
}

/** Test seam. Nothing in the CLI turns the block back off mid-run. */
export function unblockNetwork(): void {
  byFlag = false
}

/**
 * Not a `RegistryError`, so this exits 1 rather than 2.
 *
 * Exit 2 means "the network failed, retrying might help". Nothing failed here and
 * retrying will produce exactly this again — the machine was told not to go out.
 * A CI job that retries on 2 would otherwise loop on a decision it made itself.
 */
export function networkBlockedError(url: string): RarnError {
  const cause = byFlag ? '`--offline` was passed' : `${NO_NETWORK_ENV} is set`
  const how = byFlag
    ? 'Run without `--offline`. An install is fully offline when rarn.lock is up to date and every package is already cached — anything that has to ask the registry, such as a search or a new version, cannot be.'
    : `Unset ${NO_NETWORK_ENV} to allow it. If this is CI, the code under test tried to reach the network — give it a fetch stand-in instead.`

  return new RarnError({
    code: Code.NetworkBlocked,
    what: 'Network access is turned off.',
    where: url,
    detail: `  ${cause}, so Rarn refused to make this request.`,
    how,
  })
}

export function isNetworkBlocked(error: unknown): boolean {
  return error instanceof RarnError && error.code === Code.NetworkBlocked
}

export function isNetworkTimeout(error: unknown): boolean {
  return error instanceof RarnError && error.code === Code.NetworkTimeout
}

/**
 * Every request Rarn makes is a URL and an init. Narrower than `typeof fetch`, whose
 * Bun extras would force every stand-in through a cast.
 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * How long a request may wait for its response to begin.
 *
 * Not sized to the registry, which answers a metadata request in well under a second,
 * but to the slowest connection set-up measured on a limited path: the 1/3/7s SYN
 * retransmit ladder in CLAUDE.md, which a wide fan-out climbs routinely. Thirty seconds
 * clears that with room to spare. Without it the only limit was Bun's own, measured at
 * 300s — per attempt, so a dead connection sat silent for fifteen minutes behind three
 * retries.
 */
export const RESPONSE_TIMEOUT_MS = 30_000

/**
 * How long a body may go without a single byte arriving.
 *
 * Deliberately not a limit on the whole transfer. A large archive on a slow line takes
 * as long as it takes, and cutting it off would turn slowness into a failure that
 * retrying only repeats; what a live transfer never does is stop for this long.
 */
export const IDLE_TIMEOUT_MS = 30_000

export interface NetworkOptions {
  /**
   * Stands in for the network, and is deliberately not guarded: a stand-in is not the
   * network, and refusing it would make RARN_NO_NETWORK fail the suite rather than
   * protect it. The timeouts still apply, which is how they are tested.
   */
  fetch?: Fetch | undefined
  responseTimeoutMs?: number | undefined
  idleTimeoutMs?: number | undefined
}

/**
 * The one way Rarn reaches the network.
 *
 * Two properties hold for every request that comes through here, without anyone
 * remembering them at the call site: `--offline` refuses it, and a connection that
 * stops answering ends in `RN0102` instead of hanging. The auth requests were once
 * written against the global `fetch` and got neither, so `tests/network.test.ts` fails
 * any `fetch` call in `src/` outside this file.
 */
export function createFetch(options: NetworkOptions = {}): Fetch {
  const inner = options.fetch ?? guardedFetch
  const responseMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS

  return async (url, init) => {
    const controller = new AbortController()
    const outer = init?.signal
    const signal =
      outer === undefined || outer === null
        ? controller.signal
        : AbortSignal.any([outer, controller.signal])

    const response = await within(inner(url, { ...init, signal }), responseMs, controller, () =>
      timeoutError(url, `${hostOf(url)} did not answer within ${duration(responseMs)}.`),
    )
    return withIdleTimeout(response, idleMs, controller, () =>
      timeoutError(
        url,
        `${hostOf(url)} stopped sending partway through a response; nothing arrived for ${duration(idleMs)}.`,
      ),
    )
  }
}

/**
 * Reads the whole body now, so that every way it can fail happens here.
 *
 * For a caller that retries: a body can stall halfway, and one read after the retry
 * loop has returned is a stall nothing retries.
 */
export async function readFully(response: Response): Promise<Response> {
  return rebuilt(response, await response.arrayBuffer())
}

/**
 * The real network, refusing when told to.
 *
 * Reads `globalThis.fetch` per call rather than capturing it, so a test standing in
 * for the global sees exactly the requests that got past the guard.
 */
const guardedFetch: Fetch = async (url, init) => {
  if (networkBlocked()) throw networkBlockedError(url)
  return await globalThis.fetch(url, init)
}

/**
 * Races `work` against a clock, and aborts it when the clock wins.
 *
 * The abort is what frees the socket; the race is what guarantees an answer, because a
 * stand-in — or a request stuck somewhere the signal does not reach — may ignore it. The
 * timeout is settled before the abort fires, so the rejection the abort causes cannot
 * overtake it.
 */
async function within<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
  error: () => RarnError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = error()
      reject(reason)
      controller.abort(reason)
    }, ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Puts the idle clock on the body.
 *
 * It runs only while a read is waiting on the network — past the first chunk, which the
 * stream fetches eagerly, it asks for the next one only once the last has been taken —
 * so a caller slow to consume cannot trip it.
 */
function withIdleTimeout(
  response: Response,
  ms: number,
  controller: AbortController,
  error: () => RarnError,
): Response {
  const source: ReadableStream<Uint8Array> | null = response.body
  if (source === null) return response
  const reader = source.getReader()

  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      const chunk = await within(reader.read(), ms, controller, error)
      if (chunk.done) stream.close()
      else stream.enqueue(chunk.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return rebuilt(response, body)
}

function rebuilt(response: Response, body: ArrayBuffer | ReadableStream<Uint8Array>): Response {
  const copy = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // A constructed Response has an empty `url`, and the registry's errors name it.
  Object.defineProperty(copy, 'url', { value: response.url })
  return copy
}

/**
 * A `RegistryError`, so it exits 2 — the class a script retries on, which is right for
 * a connection that stalled and wrong for `RN0130`, which is why that one is not.
 */
function timeoutError(url: string, what: string): RarnError {
  return new RegistryError({
    code: Code.NetworkTimeout,
    what,
    where: url,
    how: 'The connection was abandoned rather than left to hang. This is the network, not your project — try again in a moment.',
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}
