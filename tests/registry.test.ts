import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRegistryClient } from '../src/registry/client.ts'
import { parseMetadata } from '../src/registry/parse.ts'
import { DEFAULT_API_URL } from '../src/registry/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { parseWallyName } from '../src/util/package-name.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'registry')

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as unknown
}

const promise = parseWallyName('evaera/promise')
const knit = parseWallyName('sleitnick/knit')

/**
 * A fetch stand-in driven by a routing table.
 *
 * Tests never touch the network: every response here was recorded from the live
 * registry, so the fixtures stay honest without making the suite depend on it.
 */
type FetchArgs = Parameters<typeof globalThis.fetch>
type Route = { status?: number; body?: unknown; bytes?: Uint8Array }

function fakeFetch(
  routes: Record<string, Route>,
  onRequest?: (url: string, init?: FetchArgs[1]) => void,
): typeof globalThis.fetch {
  return ((input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = input instanceof Request ? input.url : String(input)
    onRequest?.(url, init)

    const key = Object.keys(routes).find((route) => url.includes(route))
    const route = key === undefined ? undefined : routes[key]
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }))

    if (route.bytes !== undefined) {
      return Promise.resolve(new Response(route.bytes, { status: route.status ?? 200 }))
    }
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return Promise.resolve(
      new Response(body, {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof globalThis.fetch
}

/**
 * Casts a bare request handler to `fetch`.
 *
 * Bun's `fetch` type carries extras such as `preconnect`, so a plain function is
 * not assignable to it. Nothing under test touches those, so the cast is honest —
 * it just has to go through `unknown` to be allowed.
 */
function asFetch(handler: () => Promise<Response>): typeof globalThis.fetch {
  return handler as unknown as typeof globalThis.fetch
}

/** Runs `fn`, expecting it to reject, and returns the RarnError it threw. */
async function expectRejection(fn: () => Promise<unknown>): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the call succeeded')
}

describe('parseMetadata', () => {
  test('reads every published version', async () => {
    const meta = parseMetadata(promise, await fixture('evaera-promise.metadata.json'))
    expect(meta.versions.length).toBeGreaterThan(0)
    expect(meta.versions.map((v) => v.version)).toContain('4.0.0')
  })

  test('sorts newest first, prereleases included', async () => {
    const meta = parseMetadata(promise, await fixture('evaera-promise.metadata.json'))
    const versions = meta.versions.map((v) => v.version)
    expect(versions[0]).toBe('4.0.0')
    // 4.0.0-rc.2 sorts below 4.0.0 but stays in the list: whether a prerelease is
    // eligible depends on the range asking for it, which resolution decides.
    expect(versions).toContain('4.0.0-rc.2')
    expect(versions.indexOf('4.0.0')).toBeLessThan(versions.indexOf('4.0.0-rc.2'))
  })

  // The reason this layer exists at all.
  test('translates Cargo ranges to npm syntax on the way in', async () => {
    const meta = parseMetadata(knit, await fixture('sleitnick-knit.metadata.json'))
    const latest = meta.versions.find((v) => v.version === '1.7.0')
    expect(latest).toBeDefined()

    const promiseDep = latest?.dependencies.get('Promise')
    expect(promiseDep?.range).toBe('>=4.0.0 <5.0.0')
    expect(promiseDep?.range).not.toContain(',')
    expect(promiseDep?.name).toEqual({ scope: 'evaera', name: 'promise' })

    const commDep = latest?.dependencies.get('Comm')
    expect(commDep?.range).toBe('>=1.0.0 <2.0.0')
  })

  test('keys dependencies by the alias the package source requires', async () => {
    const meta = parseMetadata(knit, await fixture('sleitnick-knit.metadata.json'))
    const latest = meta.versions.find((v) => v.version === '1.7.0')
    expect([...(latest?.dependencies.keys() ?? [])].sort()).toEqual(['Comm', 'Promise'])
  })

  test('reads realm and normalizes absent place paths', async () => {
    const meta = parseMetadata(promise, await fixture('evaera-promise.metadata.json'))
    const latest = meta.versions[0]
    expect(latest?.realm).toBe('shared')
    expect(latest?.place.sharedPackages).toBeUndefined()
  })

  test('rejects a response that is not shaped like metadata', () => {
    expect(() => parseMetadata(promise, { nope: true })).toThrow(RarnError)
  })
})

describe('getMetadata', () => {
  test('fetches without an auth or version header', async () => {
    const seen: RequestInit[] = []
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch(
        { 'package-metadata': { body: await fixture('evaera-promise.metadata.json') } },
        (_url, init) => {
          if (init !== undefined) seen.push(init)
        },
      ),
    })

    await client.getMetadata(promise)
    const headers = (seen[0]?.headers ?? {}) as Record<string, string>
    expect(headers['Wally-Version']).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
  })

  // Resolution revisits the same package on every edge that points at it.
  test('caches so a repeated lookup makes one request', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch(
        { 'package-metadata': { body: await fixture('evaera-promise.metadata.json') } },
        () => {
          calls++
        },
      ),
    })

    await client.getMetadata(promise)
    await client.getMetadata(promise)
    await Promise.all([client.getMetadata(promise), client.getMetadata(promise)])
    expect(calls).toBe(1)
  })

  test('does not cache a failure', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 1,
      fetch: fakeFetch({ 'package-metadata': { status: 503, body: { message: 'down' } } }, () => {
        calls++
      }),
    })

    await expectRejection(() => client.getMetadata(promise))
    await expectRejection(() => client.getMetadata(promise))
    expect(calls).toBe(2)
  })
})

describe('error handling', () => {
  // Verified against the live API: an unknown package answers 500, not 404.
  test('reports the 500-that-means-missing as a missing package', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      fetch: fakeFetch({
        'package-metadata': {
          status: 500,
          body: { message: 'could not open package nobody/nope from index' },
        },
      }),
    })

    const error = await expectRejection(() => client.getMetadata(promise))
    expect(error.code).toBe(Code.PackageNotFound)
    expect(error.what).toContain('does not exist')
  })

  // Retrying a permanent failure just delays the message the user needs.
  test('does not retry that 500', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 4,
      retryDelayMs: 1,
      fetch: fakeFetch(
        {
          'package-metadata': {
            status: 500,
            body: { message: 'could not open package x from index' },
          },
        },
        () => {
          calls++
        },
      ),
    })

    await client.getMetadata(promise).catch(() => undefined)
    expect(calls).toBe(1)
  })

  test('retries a genuine server error, then gives up', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      fetch: fakeFetch(
        { 'package-metadata': { status: 503, body: { message: 'overloaded' } } },
        () => {
          calls++
        },
      ),
    })

    const error = await expectRejection(() => client.getMetadata(promise))
    expect(calls).toBe(3)
    expect(error.code).toBe(Code.RegistryBadResponse)
  })

  test('succeeds when a retry succeeds', async () => {
    let calls = 0
    const body = await fixture('evaera-promise.metadata.json')
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(
          calls < 3
            ? new Response('{"message":"overloaded"}', { status: 503 })
            : new Response(JSON.stringify(body), { status: 200 }),
        )
      }),
    })

    expect((await client.getMetadata(promise)).versions.length).toBeGreaterThan(0)
    expect(calls).toBe(3)
  })

  test('does not retry a 4xx', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 4,
      retryDelayMs: 1,
      fetch: fakeFetch({ 'package-metadata': { status: 400, body: { message: 'bad' } } }, () => {
        calls++
      }),
    })

    await client.getMetadata(promise).catch(() => undefined)
    expect(calls).toBe(1)
  })

  // A 426 means Rarn sent a stale header — the user's project is fine.
  test('blames Rarn, not the user, for a 426', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 1,
      fetch: fakeFetch({
        'package-contents': { status: 426, body: { message: 'Wally version header required.' } },
      }),
    })

    const error = await expectRejection(() => client.getContents(promise, '4.0.0'))
    expect(error.code).toBe(Code.WallyVersionHeaderRejected)
    expect(error.how).toContain('bug in Rarn')
  })

  test('reports a network failure as unreachable', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 1,
      fetch: asFetch(() => Promise.reject(new Error('ECONNREFUSED'))),
    })

    const error = await expectRejection(() => client.getMetadata(promise))
    expect(error.code).toBe(Code.RegistryUnreachable)
  })
})

describe('getContents', () => {
  // Omitting this header is a 426, so it is not optional.
  test('sends the Wally-Version header', async () => {
    const seen: RequestInit[] = []
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch(
        { 'package-contents': { bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) } },
        (_url, init) => {
          if (init !== undefined) seen.push(init)
        },
      ),
    })

    const bytes = await client.getContents(promise, '4.0.0')
    const headers = (seen[0]?.headers ?? {}) as Record<string, string>
    expect(headers['Wally-Version']).toBeDefined()
    // The body is a ZIP even though the response says application/gzip.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  test('builds the path from scope, name and version', async () => {
    const urls: string[] = []
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({ 'package-contents': { bytes: new Uint8Array([1]) } }, (url) => {
        urls.push(url)
      }),
    })

    await client.getContents(promise, '4.0.0')
    expect(urls[0]).toBe('https://api.wally.run/v1/package-contents/evaera/promise/4.0.0')
  })

  test('adds a bearer token only when one is configured', async () => {
    const seen: RequestInit[] = []
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      token: 'secret',
      fetch: fakeFetch({ 'package-contents': { bytes: new Uint8Array([1]) } }, (_url, init) => {
        if (init !== undefined) seen.push(init)
      }),
    })

    await client.getContents(promise, '4.0.0')
    expect((seen[0]?.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })
})

describe('API url resolution', () => {
  // The stock index has pointed at the same API for the life of the registry;
  // spending a round trip per run to rediscover it would be waste.
  test('uses the known API for the stock index without any request', async () => {
    let calls = 0
    const client = createRegistryClient({
      fetch: fakeFetch(
        { 'package-metadata': { body: await fixture('evaera-promise.metadata.json') } },
        (url) => {
          if (url.includes('config.json')) calls++
        },
      ),
    })

    await client.getMetadata(promise)
    expect(calls).toBe(0)
  })

  test('reads config.json for a custom GitHub index', async () => {
    const urls: string[] = []
    const client = createRegistryClient({
      indexUrl: 'https://github.com/someone/their-index',
      fetch: fakeFetch(
        {
          'config.json': { body: { api: 'https://api.example.com/' } },
          'package-metadata': { body: await fixture('evaera-promise.metadata.json') },
        },
        (url) => urls.push(url),
      ),
    })

    await client.getMetadata(promise)
    expect(urls[0]).toBe('https://raw.githubusercontent.com/someone/their-index/main/config.json')
    expect(urls[1]?.startsWith('https://api.example.com/')).toBe(true)
  })

  test('resolves the API url once, not per request', async () => {
    let configCalls = 0
    const client = createRegistryClient({
      indexUrl: 'https://github.com/someone/their-index',
      fetch: fakeFetch(
        {
          'config.json': { body: { api: 'https://api.example.com/' } },
          'package-metadata': { body: await fixture('sleitnick-knit.metadata.json') },
          'package-contents': { bytes: new Uint8Array([1]) },
        },
        (url) => {
          if (url.includes('config.json')) configCalls++
        },
      ),
    })

    await client.getMetadata(knit)
    await client.getContents(knit, '1.7.0')
    expect(configCalls).toBe(1)
  })

  test('refuses an index it cannot derive a config url from', async () => {
    const client = createRegistryClient({
      indexUrl: 'https://gitlab.com/someone/their-index',
      fetch: fakeFetch({}),
    })

    const error = await expectRejection(() => client.getMetadata(promise))
    expect(error.how).toContain('GitHub')
  })
})

describe('search', () => {
  test('parses results and tolerates missing fields', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({
        'package-search': {
          body: [
            { name: 'evaera/promise', versions: ['4.0.0'], description: 'Promises' },
            { name: 'sleitnick/knit' },
          ],
        },
      }),
    })

    const results = await client.search('promise')
    expect(results[0]?.name).toEqual({ scope: 'evaera', name: 'promise' })
    expect(results[0]?.description).toBe('Promises')
    expect(results[1]?.versions).toEqual([])
    expect(results[1]?.description).toBeUndefined()
  })

  test('encodes the query', async () => {
    const urls: string[] = []
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({ 'package-search': { body: [] } }, (url) => urls.push(url)),
    })

    await client.search('a b&c')
    expect(urls[0]).toContain('query=a%20b%26c')
  })
})
