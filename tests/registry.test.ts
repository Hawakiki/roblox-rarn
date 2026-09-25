import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import lockSchema from '../schemas/rarn.lock.schema.json' with { type: 'json' }
import { info } from '../src/cli/commands/info.ts'
import { createRegistryClient } from '../src/registry/client.ts'
import { parseMetadata } from '../src/registry/parse.ts'
import { DEFAULT_API_URL, type WireMetadata } from '../src/registry/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError, RegistryError } from '../src/util/errors.ts'
import { blockNetwork, networkBlocked, unblockNetwork } from '../src/util/network.ts'
import { isExactVersion, parseWallyName } from '../src/util/package-name.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'registry')

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as unknown
}

const promise = parseWallyName('evaera/promise')
const knit = parseWallyName('sleitnick/knit')

/** What `rarn publish` passes along as the version being published. */
const PUBLISHED = '@evaera/promise@4.0.0'

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

async function stdoutOf(run: () => Promise<void>): Promise<string> {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk))
    return true
  }
  try {
    await run()
  } finally {
    process.stdout.write = original
  }
  return written.join('')
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

  // The registry does hold versions semver cannot read: kampfkarren/react-roblox-act
  // publishes 0.0.0-001 beside five that are fine, and yesavnd/iris only 2.4.1-090425
  // (wally-index, 2026-09-25). A version becomes a folder name, and one outside the
  // rule would also be written into a lockfile that then refuses to load. Both halves
  // of the rule refuse these; the two tests after this one take each half alone.
  test('leaves out a version outside semver 2.0.0, and keeps the rest', async () => {
    const body = await promiseAlsoPublishing('0.0.0-001', '4.0.0/../../../ESCAPED')
    const versions = parseMetadata(promise, body).versions.map((v) => v.version)

    expect(versions).not.toContain('0.0.0-001')
    expect(versions).not.toContain('4.0.0/../../../ESCAPED')
    expect(versions[0]).toBe('4.0.0')
  })

  // The grammar is not everything semver checks. It also refuses a component past
  // Number.MAX_SAFE_INTEGER and a version longer than 256 characters, which the grammar
  // admits and Wally's Rust semver (u64 components) can publish. It refuses them by
  // throwing, from the sort in parseMetadata, so one such version would fail every
  // command that reads the package with a bare TypeError.
  test('leaves out a version the grammar admits and semver still cannot read', async () => {
    const unreadable = ['9007199254740993.0.0', '1.9007199254740993.0', `4.0.1-${'a'.repeat(300)}`]
    // Pinned so this stays a test of the second rule: were the grammar ever to refuse
    // these, the case above would already cover them and this one would prove nothing.
    expect(unreadable.filter((v) => !isExactVersion(v))).toEqual([])

    const body = await promiseAlsoPublishing(...unreadable)
    const versions = parseMetadata(promise, body).versions.map((v) => v.version)

    expect(versions.filter((v) => unreadable.includes(v))).toEqual([])
    expect(versions[0]).toBe('4.0.0')
  })

  // The grammar's half, as the case above is semver's. semver trims whitespace and takes
  // a leading `v`, so each of these satisfies `^4.0.0` exactly as the 4.0.1 it spells
  // does. Kept, one would be selected, and `toIndexDir`, which holds a version to the
  // grammar, would then stop the install as a bug in Rarn.
  test('leaves out a spelling semver reads leniently and the grammar refuses', async () => {
    const lenient = ['v4.0.1', ' 4.0.1', '4.0.1 ']
    // Pinned so this stays a test of the grammar: were semver ever to refuse these, its
    // own half would already leave them out and this one would prove nothing.
    expect(lenient.filter((v) => semver.valid(v) === null)).toEqual([])

    const body = await promiseAlsoPublishing(...lenient)
    const versions = parseMetadata(promise, body).versions.map((v) => v.version)

    expect(versions.filter((v) => lenient.includes(v))).toEqual([])
    expect(versions[0]).toBe('4.0.0')
  })

  test('keeps a version carrying build metadata', async () => {
    const body = await promiseAlsoPublishing('4.0.1+89e7')
    expect(parseMetadata(promise, body).versions[0]?.version).toBe('4.0.1+89e7')
  })
})

/** The recorded promise metadata, plus a copy of its first entry under each `version`. */
async function promiseAlsoPublishing(...versions: string[]): Promise<WireMetadata> {
  const body = (await fixture('evaera-promise.metadata.json')) as WireMetadata
  const [first] = body.versions
  const pkg = first?.package
  if (first === undefined || pkg === undefined) throw new Error('the promise fixture is empty')
  for (const version of versions) body.versions.push({ ...first, package: { ...pkg, version } })
  return body
}

type WireSection = 'dependencies' | 'server-dependencies' | 'dev-dependencies'

/**
 * The recorded knit metadata, with one more dependency declared under `alias`.
 *
 * Built from a recording rather than stored beside them: every file in fixtures/ came
 * off the live registry, and a hand-written one there would pass for one that did. The
 * registry does not check an alias at all — Wally's backend reads wally.toml's
 * dependency keys as plain strings — so every alias below is one anybody can publish.
 */
async function knitDeclaring(alias: string, section: WireSection = 'dependencies') {
  const body = (await fixture('sleitnick-knit.metadata.json')) as WireMetadata
  const entry = body.versions.find((v) => v.package?.version === '1.7.0')
  if (entry === undefined) throw new Error('the knit fixture no longer holds 1.7.0')
  entry[section] = { ...entry[section], [alias]: 'evaera/promise@>=4.0.0, <5.0.0' }
  return body
}

function parseError(body: unknown): RarnError | undefined {
  try {
    parseMetadata(knit, body)
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
}

describe('dependency aliases', () => {
  // The alias becomes `<alias>.luau` inside the package's _Index entry. Each of these
  // names somewhere else: a parent directory, a subdirectory, an NTFS alternate stream
  // on a file beside the shim (`C:evil` is one too — `join` does not change drive), or
  // a file the extension no longer describes.
  test.each([
    '../../../../src/Main',
    '..',
    '.',
    '',
    'a/b',
    'a\\b',
    '/etc/evil',
    'C:evil',
    'Promise:evil',
    'Promise.server',
    'Pro mise',
    'Promise\n',
    '-Promise',
  ])('refuses %p, naming the package, the version and the alias', async (alias) => {
    const error = parseError(await knitDeclaring(alias))

    expect(error?.code).toBe(Code.UnsafeDependencyAlias)
    expect(error?.where).toBe('sleitnick/knit@1.7.0')
    // Quoted as JSON, so that a newline or a trailing space is visible in the message.
    expect(error?.format()).toContain(JSON.stringify(alias))
  })

  test('refuses a server dependency the same way', async () => {
    const error = parseError(await knitDeclaring('../../evil', 'server-dependencies'))
    expect(error?.code).toBe(Code.UnsafeDependencyAlias)
    expect(error?.detail).toContain('[server-dependencies]')
  })

  // A registry package's dev-dependencies are never resolved, linked or shown — Wally
  // does not install them either — so no file is ever named after one. Refusing the
  // package over one would fail an install for a file that was never going to exist.
  test('leaves dev-dependencies alone, since none of them becomes a file', async () => {
    const meta = parseMetadata(knit, await knitDeclaring('Test EZ', 'dev-dependencies'))
    const entry = meta.versions.find((v) => v.version === '1.7.0')
    expect(entry?.devDependencies.has('Test EZ')).toBe(true)
  })

  // The rule has to admit what the registry actually holds, and a Luau-identifier rule
  // does not: in wally-index on 2026-09-25 it would have refused 777 versions of 214
  // packages, every one of them over a hyphen. All of these are real aliases.
  test.each(['luau-polyfill', 'es7-types', 'instance-of', 'symbol-luau', '_jest-roblox-shared'])(
    'accepts %p',
    async (alias) => {
      const meta = parseMetadata(knit, await knitDeclaring(alias))
      const entry = meta.versions.find((v) => v.version === '1.7.0')
      expect(entry?.dependencies.has(alias)).toBe(true)
    },
  )

  // Every alias parsed here is written into rarn.lock, and the lockfile schema is what
  // reads it back. A parser wider than the schema is how install once wrote a lockfile
  // it then refused to read.
  test('admits exactly what the lockfile schema admits', async () => {
    const pattern = new RegExp(lockSchema.$defs.alias.pattern)
    for (const alias of ['luau-polyfill', 'Promise', '_', '-x', 'a.b', '../x', 'a b', 'a:b', '']) {
      const admitted = parseError(await knitDeclaring(alias)) === undefined
      expect({ alias, admitted }).toEqual({ alias, admitted: pattern.test(alias) })
    }
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
  // Driven by a recorded response, not a hand-written one. The first version of
  // this test invented `{ name: "evaera/promise" }` and passed, while the live
  // endpoint actually sends `scope` and `name` as separate fields — so the parser
  // was broken on every real search and the suite said it was fine.
  test('reads the split scope and name the live endpoint really sends', async () => {
    const recorded = (await fixture('search-knit.json')) as { scope: string; name: string }[]
    expect(recorded[0]).toHaveProperty('scope')

    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({ 'package-search': { body: recorded } }),
    })

    const results = await client.search('knit')
    expect(results).toHaveLength(recorded.length)
    expect(results[0]?.name).toEqual({
      scope: recorded[0]?.scope ?? '',
      name: recorded[0]?.name ?? '',
    })
  })

  test('also accepts a combined scope/name string', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({
        'package-search': { body: [{ name: 'evaera/promise', versions: ['4.0.0'] }] },
      }),
    })

    expect((await client.search('promise'))[0]?.name).toEqual({
      scope: 'evaera',
      name: 'promise',
    })
  })

  test('tolerates missing optional fields', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({ 'package-search': { body: [{ scope: 'sleitnick', name: 'knit' }] } }),
    })

    const results = await client.search('knit')
    expect(results[0]?.versions).toEqual([])
    expect(results[0]?.description).toBeUndefined()
  })

  test('rejects an entry with no usable name', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({ 'package-search': { body: [{ description: 'nameless' }] } }),
    })

    await expectRejection(() => client.search('x'))
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

/**
 * Fails the test instead of hanging the run.
 *
 * Measured on Bun 1.3.14: a test awaiting a promise that never settles, with no timer
 * or socket keeping the loop busy, is never timed out — `--timeout` does not fire and
 * the whole `bun test` hangs. A hang is exactly the defect these tests exist to catch,
 * so each one brings its own clock.
 */
async function watchdog<T>(work: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`still pending after ${ms}ms — nothing ended the wait`))
    }, ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** A request that is accepted and then never answered — the fetch promise stays pending. */
function silent(onCall?: () => void): typeof globalThis.fetch {
  return asFetch(() => {
    onCall?.()
    return new Promise<Response>(() => undefined)
  })
}

/** A body that sends `head` and then nothing more, without ever closing. */
function stalledBody(head: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head)
    },
  })
}

/** A body that arrives in `parts` slices, one every `gapMs` — slow, but never stopped. */
function tricklingBody(
  bytes: Uint8Array,
  parts: number,
  gapMs: number,
): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.length / parts)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, gapMs))
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
      if (offset >= bytes.length) controller.close()
    },
  })
}

describe('timeouts', () => {
  // Nothing bounded the wait but Bun's own 300s limit, and `withRetry` could only
  // retry a request that ended — so three attempts at a dead connection sat silent
  // for fifteen minutes before saying anything.
  test('a request that never answers times out instead of hanging', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 2,
      retryDelayMs: 1,
      responseTimeoutMs: 20,
      fetch: silent(() => {
        calls++
      }),
    })

    const error = await expectRejection(() => watchdog(client.getMetadata(promise)))
    expect(error.code).toBe(Code.NetworkTimeout)
    // Exit 2: the network failed and retrying might help, same as unreachable.
    expect(error).toBeInstanceOf(RegistryError)
    expect(calls).toBe(2)
  })

  test('a timeout is retried like any other transport failure', async () => {
    let calls = 0
    const body = JSON.stringify(await fixture('evaera-promise.metadata.json'))
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      responseTimeoutMs: 20,
      fetch: asFetch(() => {
        calls++
        return calls === 1
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(new Response(body, { status: 200 }))
      }),
    })

    expect((await watchdog(client.getMetadata(promise))).versions.length).toBeGreaterThan(0)
    expect(calls).toBe(2)
  })

  // The body used to be read after the retry loop had already returned, so a stall
  // halfway through a download was not retried at all — and after 300s it surfaced
  // as a bare DOMException, which renders as RN0003 "a bug in Rarn" with exit 1.
  test('a body that stalls halfway times out, and the retry recovers', async () => {
    let calls = 0
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 2,
      retryDelayMs: 1,
      idleTimeoutMs: 20,
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response(stalledBody(bytes.slice(0, 4)), { status: 200 })
            : new Response(bytes, { status: 200 }),
        )
      }),
    })

    expect([...(await watchdog(client.getContents(promise, '4.0.0')))]).toEqual([...bytes])
    expect(calls).toBe(2)
  })

  test('a stalled body with no retries left reports a timeout', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 1,
      idleTimeoutMs: 20,
      fetch: asFetch(() =>
        Promise.resolve(new Response(stalledBody(new Uint8Array([1])), { status: 200 })),
      ),
    })

    const error = await expectRejection(() => watchdog(client.getContents(promise, '4.0.0')))
    expect(error.code).toBe(Code.NetworkTimeout)
    expect(error).toBeInstanceOf(RegistryError)
  })

  // The failure a timeout must not introduce. A large archive on a slow line takes
  // far longer than the idle limit in total; what it never does is stop.
  test('a slow body that keeps arriving is never cut off', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(await fixture('evaera-promise.metadata.json')),
    )
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 1,
      responseTimeoutMs: 200,
      idleTimeoutMs: 200,
      fetch: asFetch(() =>
        Promise.resolve(new Response(tricklingBody(bytes, 20, 25), { status: 200 })),
      ),
    })

    const started = Date.now()
    expect((await watchdog(client.getMetadata(promise))).versions.length).toBeGreaterThan(0)
    // Longer than either limit in total, which is the point.
    expect(Date.now() - started).toBeGreaterThan(200)
  })

  // A retry after a timeout is a second publish. The registry would refuse it with
  // 409, which is safe and reads as a failure of something that may have worked.
  test('a publish that times out is not retried, and says it may have gone through', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      uploadTimeoutMs: 20,
      fetch: silent(() => {
        calls++
      }),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expect(calls).toBe(1)
    expect(error.code).toBe(Code.NetworkTimeout)
    expect(`${error.detail ?? ''} ${error.how ?? ''}`).toContain('may have been published')
  })

  // The advice is read at the most anxious moment a publish has, and typed exactly as
  // printed — so it names the version being published, and the command has to be one
  // `info` accepts. A test that only looked for the words "rarn info" would be
  // satisfied by a spec without the leading `@`, which `info` answers with RN0020.
  test('the check a timed-out publish recommends runs as written', async () => {
    const timedOut = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      uploadTimeoutMs: 20,
      fetch: silent(),
    })
    const error = await expectRejection(() =>
      watchdog(timedOut.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )

    const spec = /`rarn info ([^`]+)`/.exec(error.how ?? '')?.[1]
    expect(spec).toBe(PUBLISHED)

    const registry = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({
        'package-metadata/evaera/promise': { body: await fixture('evaera-promise.metadata.json') },
      }),
    })
    const printed = await stdoutOf(() => info({ cwd: '.', spec: spec ?? '', json: true }, registry))
    expect((JSON.parse(printed) as { version: string }).version).toBe('4.0.0')
  })

  // The status line already says whether it was published; the body is only the
  // registry's wording. Failing here would report a publish that worked as one
  // that did not.
  test('a publish whose response body stalls still reports the status it got', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      idleTimeoutMs: 20,
      fetch: asFetch(() =>
        Promise.resolve(new Response(stalledBody(new Uint8Array([0x6f])), { status: 200 })),
      ),
    })

    expect((await watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED))).status).toBe(
      200,
    )
  })
})

/**
 * What Bun's fetch rejects with, measured on Bun 1.3.14 against local sockets. A closed
 * port, a host name that does not resolve and a peer that does not speak TLS give
 * `ConnectionRefused`. A certificate the client refuses gives a code of its own, one per
 * reason (the measured list is `NEVER_CONNECTED` in `registry/client.ts`). A server that
 * accepts and then closes gives `ECONNRESET` whether it closed before reading a byte or
 * after reading the whole upload — which is why that one cannot say whether anything was
 * published.
 */
function transportFailure(code: string, message = 'the socket failed'): Error {
  return Object.assign(new Error(message), { code })
}

function expectOutcomeUnknown(error: RarnError): void {
  expect(error).toBeInstanceOf(RegistryError)
  expect(error.detail ?? '').toContain('may have been published')
  expect(error.how ?? '').toContain(`\`rarn info ${PUBLISHED}\``)
  expect(`${error.detail ?? ''} ${error.how ?? ''}`).not.toContain('Nothing was published')
}

function expectNothingPublished(error: RarnError): void {
  expect(error.how ?? '').toContain('Nothing was published')
  expect(`${error.detail ?? ''} ${error.how ?? ''}`).not.toContain('may have been published')
}

// The registry stores the archive, commits the version to its index, and only then
// recrawls the whole index for search — synchronously, before answering. The slow
// publishes are therefore the ones already past the point of no return, and a published
// version is permanent. Telling someone nothing was published when it was is the
// harmful direction; the other costs one `rarn info`.
describe('a publish whose outcome is unknown says so', () => {
  test('a 504 may have been published, and is not retried', async () => {
    let calls = 0
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      attempts: 3,
      retryDelayMs: 1,
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(new Response('upstream request timeout', { status: 504 }))
      }),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expect(calls).toBe(1)
    expect(error.code).toBe(Code.NetworkTimeout)
    expectOutcomeUnknown(error)
  })

  // The recrawl's failure propagates as the backend's default 500, after the commit.
  // The same status also comes from failures before it, so a 5xx cannot say which.
  test.each([500, 502, 503])('a %d may have been published', async (status) => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: asFetch(() =>
        Promise.resolve(Response.json({ message: 'something broke' }, { status })),
      ),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expect(error.what).toContain(String(status))
    expect(error.detail).toContain('something broke')
    expectOutcomeUnknown(error)
  })

  // Every 4xx the registry sends is a refusal made before anything is stored.
  test.each([404, 413, 429])('a %d means nothing was published', async (status) => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: asFetch(() => Promise.resolve(Response.json({ message: 'no' }, { status }))),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expectNothingPublished(error)
  })

  test('a connection reset may have been published', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: asFetch(() => Promise.reject(transportFailure('ECONNRESET'))),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expectOutcomeUnknown(error)
  })

  test('a connection that was never made means nothing was published', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: asFetch(() => Promise.reject(transportFailure('ConnectionRefused'))),
    })

    const error = await expectRejection(() =>
      watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
    )
    expect(error).toBeInstanceOf(RegistryError)
    expect(error.code).toBe(Code.RegistryUnreachable)
    expectNothingPublished(error)
  })

  // Each code and message is what Bun 1.3.14 rejected with, measured against a local TLS
  // server that received not one byte of a 64 KiB upload. The message is the only thing
  // that names the certificate without --verbose, so it has to reach the reader — all of
  // it except the advice Bun appends about fetch(), which a binary's user cannot follow.
  const altname = 'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://api.wally.run/v1/publish"'
  const failures: [code: string, message: string, shown: string][] = [
    ['SELF_SIGNED_CERT_IN_CHAIN', 'self signed certificate in certificate chain'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['CERT_NOT_YET_VALID', 'certificate is not yet valid'],
    // A peer that closed after the ClientHello, not a certificate: no session existed either.
    ['UNKNOWN_CERTIFICATE_VERIFICATION_ERROR', 'unknown certificate verification error'],
  ].map(([code, message]) => [code, message, message] as [string, string, string])
  failures.push([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    `${altname}. For more information, pass \`verbose: true\` in the second argument to fetch()`,
    altname,
  ])
  test.each(failures)(
    'a TLS failure before the request (%s) means nothing was published',
    async (code, message, shown) => {
      const client = createRegistryClient({
        apiUrl: DEFAULT_API_URL,
        fetch: asFetch(() => Promise.reject(transportFailure(code, message))),
      })

      const error = await expectRejection(() =>
        watchdog(client.publish(new Uint8Array([1]), 'token', PUBLISHED)),
      )
      expect(error.code).toBe(Code.RegistryUnreachable)
      expect(error.detail).toContain(shown)
      expect(error.detail).not.toContain('fetch()')
      expectNothingPublished(error)
    },
  )
})

describe('RARN_NO_NETWORK', () => {
  /**
   * Async on purpose. A synchronous version restores the variable the moment
   * `run` returns its promise — before the request it started has been made — so
   * the guard would be off by the time it mattered and the test would quietly go
   * out to the real registry. It did, the first time this was written.
   */
  async function withBlock<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
    const previous = process.env.RARN_NO_NETWORK
    set(value)
    try {
      return await run()
    } finally {
      set(previous)
    }
  }

  /**
   * Unset goes through `Reflect.deleteProperty`, not `delete`.
   *
   * Not a style choice — biome's `noDelete` rule offers to rewrite `delete` as
   * `process.env.X = undefined`, and on `process.env` that assigns the *string*
   * `"undefined"`. The variable would then be set to a truthy value, so accepting
   * that fix turns "restore it to unset" into "leave the block switched on" and
   * every test after this one inherits it.
   */
  function set(value: string | undefined): void {
    if (value === undefined) Reflect.deleteProperty(process.env, 'RARN_NO_NETWORK')
    else process.env.RARN_NO_NETWORK = value
  }

  test('refuses a real request instead of making it', async () => {
    // No `fetch` option, so this client would genuinely go out to api.wally.run.
    // That is the case the guard exists for, and the only way to test it is to let
    // the client be the real one.
    const client = createRegistryClient()
    const error = await withBlock('1', async () => {
      try {
        await client.getMetadata(promise)
        return undefined
      } catch (thrown) {
        return thrown
      }
    })

    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(Code.NetworkBlocked)
    expect((error as RarnError).where).toContain('api.wally.run')
  })

  // The guard has to be invisible to the suite, or turning it on in CI would fail
  // every test that models the registry rather than the one test that calls it.
  test('leaves an injected fetch alone', async () => {
    const client = createRegistryClient({
      apiUrl: DEFAULT_API_URL,
      fetch: fakeFetch({
        'package-metadata': { body: await fixture('evaera-promise.metadata.json') },
      }),
    })

    const metadata = await withBlock('1', async () => await client.getMetadata(promise))
    expect(metadata.versions.length).toBeGreaterThan(0)
  })

  // `--offline` reuses the same guard rather than growing a second one. What it does
  // not reuse is the message: telling someone who typed `--offline` to unset an
  // environment variable they never set reads as a misdiagnosis, and a reader who
  // decides the tool has misread them stops reading the rest of it.
  test('--offline blocks too, and says so in its own terms', async () => {
    const client = createRegistryClient()
    blockNetwork()
    try {
      await client.getMetadata(promise)
      throw new Error('expected a rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(RarnError)
      const error = thrown as RarnError
      expect(error.code).toBe(Code.NetworkBlocked)
      expect(error.detail).toContain('--offline')
      expect(error.detail).not.toContain('RARN_NO_NETWORK')
      expect(error.how).toContain('--offline')
    } finally {
      unblockNetwork()
    }
  })

  test('the flag wins over an unset variable', async () => {
    expect(await withBlock(undefined, () => networkBlocked())).toBe(false)
    blockNetwork()
    try {
      expect(await withBlock(undefined, () => networkBlocked())).toBe(true)
    } finally {
      unblockNetwork()
    }
    expect(await withBlock(undefined, () => networkBlocked())).toBe(false)
  })

  test('0 means off, so a job can opt back in', async () => {
    expect(await withBlock('0', () => networkBlocked())).toBe(false)
    expect(await withBlock('', () => networkBlocked())).toBe(false)
    expect(await withBlock(undefined, () => networkBlocked())).toBe(false)
    expect(await withBlock('1', () => networkBlocked())).toBe(true)
    expect(await withBlock('false', () => networkBlocked())).toBe(true)
  })
})
