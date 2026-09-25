import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Code } from '../src/util/codes.ts'
import { RarnError, RegistryError } from '../src/util/errors.ts'
import { type Fetch, blockNetwork, createFetch, unblockNetwork } from '../src/util/network.ts'

const SRC = join(import.meta.dir, '..', 'src')
const URL_ = 'https://api.wally.run/v1/package-metadata/evaera/promise'

/** A stalled body: `head`, then nothing, never closed. */
function stalled(head: Uint8Array): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head)
      },
    }),
    { status: 200 },
  )
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<RarnError> {
  // Its own clock, because Bun 1.3.14 never times out a test whose only pending work is
  // a promise nothing will settle — see the note on `watchdog` in registry.test.ts.
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('still pending after 2000ms'))
    }, 2000)
  })
  try {
    await Promise.race([fn(), expired])
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  } finally {
    clearTimeout(timer)
  }
  throw new Error('expected a rejection but the call succeeded')
}

describe('createFetch', () => {
  test('gives up on a request that never answers, and aborts it', async () => {
    let seen: AbortSignal | undefined
    const network = createFetch({
      responseTimeoutMs: 20,
      fetch: (_url, init) => {
        seen = init?.signal ?? undefined
        return new Promise<Response>(() => undefined)
      },
    })

    const error = await rejectionOf(() => network(URL_))
    expect(error.code).toBe(Code.NetworkTimeout)
    expect(error).toBeInstanceOf(RegistryError)
    expect(error.where).toBe(URL_)
    expect(error.what).toContain('api.wally.run')
    // The race guarantees an answer; the abort is what lets the socket go.
    expect(seen?.aborted).toBe(true)
  })

  // The design leans on the stream's error arriving as itself. If a body reader wrapped
  // it, the registry client would report a stall as "could not reach the registry".
  test.each([
    ['arrayBuffer', (r: Response) => r.arrayBuffer()],
    ['text', (r: Response) => r.text()],
    ['json', (r: Response) => r.json()],
  ] as const)('a stalled body fails %s with the timeout itself', async (_name, read) => {
    const network = createFetch({
      idleTimeoutMs: 20,
      fetch: () => Promise.resolve(stalled(new TextEncoder().encode('{"a":'))),
    })

    const response = await network(URL_)
    const error = await rejectionOf(() => read(response))
    expect(error.code).toBe(Code.NetworkTimeout)
  })

  test('keeps status, headers and url', async () => {
    const network = createFetch({
      fetch: () =>
        Promise.resolve(
          Object.defineProperty(
            new Response('gone', { status: 410, statusText: 'Gone', headers: { 'x-a': 'b' } }),
            'url',
            { value: URL_ },
          ),
        ),
    })

    const response = await network(URL_)
    expect(response.status).toBe(410)
    expect(response.statusText).toBe('Gone')
    expect(response.headers.get('x-a')).toBe('b')
    expect(response.url).toBe(URL_)
    expect(await response.text()).toBe('gone')
  })

  test("still honours the caller's own signal", async () => {
    let seen: AbortSignal | undefined
    const network = createFetch({
      fetch: (_url, init) => {
        seen = init?.signal ?? undefined
        return Promise.resolve(new Response('ok'))
      },
    })

    const caller = new AbortController()
    caller.abort()
    await network(URL_, { signal: caller.signal })
    expect(seen?.aborted).toBe(true)
  })

  test('leaves a stand-in unguarded, and the real network guarded', async () => {
    const standIn: Fetch = () => Promise.resolve(new Response('ok'))
    const original = globalThis.fetch
    let reached = 0
    globalThis.fetch = (() => {
      reached++
      return Promise.resolve(new Response('real'))
    }) as unknown as typeof globalThis.fetch

    blockNetwork()
    try {
      expect(await (await createFetch({ fetch: standIn })(URL_)).text()).toBe('ok')
      const error = await rejectionOf(() => createFetch()(URL_))
      expect(error.code).toBe(Code.NetworkBlocked)
      expect(reached).toBe(0)
    } finally {
      unblockNetwork()
      globalThis.fetch = original
    }
  })
})

/**
 * The guard only covers what goes through it, and "remember to use the wrapper" is the
 * convention that already failed once: `publish/auth.ts` called the global fetch three
 * times, so `--offline` never reached login or whoami and nothing but Bun's own 300s
 * limit bounded how long they could hang. This makes the convention a check.
 */
describe('every request goes through createFetch', () => {
  const ENTRY = join(SRC, 'util', 'network.ts')
  const BYPASS = [
    /(?<![\w.$])fetch\s*\(/,
    /globalThis\.fetch/,
    /\bBun\.fetch\b/,
    /['"]node:(?:http|https|net|tls)['"]/,
  ]

  test('nothing in src reaches the network any other way', async () => {
    const offenders: string[] = []
    for (const entry of await readdir(SRC, { recursive: true })) {
      const path = join(SRC, entry)
      if (!path.endsWith('.ts') || path === ENTRY) continue
      const lines = (await readFile(path, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (BYPASS.some((pattern) => pattern.test(line))) {
          offenders.push(`${relative(SRC, path)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
