import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { login } from '../src/cli/commands/login.ts'
import { whoami } from '../src/cli/commands/whoami.ts'
import {
  authFilePath,
  awaitDeviceToken,
  githubLogin,
  startDeviceFlow,
  writeToken,
} from '../src/publish/auth.ts'
import { createRegistryClient } from '../src/registry/client.ts'
import { DEFAULT_API_URL } from '../src/registry/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError, RegistryError } from '../src/util/errors.ts'
import { blockNetwork, unblockNetwork } from '../src/util/network.ts'

/**
 * Stands in for the global fetch and records every call that reaches it.
 *
 * The auth calls take no injected fetch — they are the real network by definition —
 * so the global is the only place to watch them from. It answers plausibly on
 * purpose: a request that should have been refused then *succeeds*, rather than
 * failing for some unrelated reason and passing the test by accident.
 */
async function withRecordedFetch<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    if (url.includes('/device/code')) {
      return Promise.resolve(Response.json({ device_code: 'd', user_code: 'ABCD-1234' }))
    }
    if (url.includes('/access_token')) return Promise.resolve(Response.json({ access_token: 't' }))
    return Promise.resolve(Response.json({ login: 'someone' }))
  }) as unknown as typeof globalThis.fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the call succeeded')
}

const grant = {
  deviceCode: 'd',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  intervalMs: 0,
  expiresAt: Date.now() + 60_000,
}

// These three called the global fetch directly, so `--offline` and RARN_NO_NETWORK
// never saw them: `rarn login` and `rarn whoami` went out to GitHub regardless.
describe('auth requests honour the offline guard', () => {
  test.each([
    ['startDeviceFlow', () => startDeviceFlow('client')],
    ['awaitDeviceToken', () => awaitDeviceToken('client', grant)],
    ['githubLogin', () => githubLogin('token')],
  ] as const)('%s is refused without touching the network', async (_name, call) => {
    blockNetwork()
    try {
      await withRecordedFetch(async (calls) => {
        const error = await rejectionOf(call)
        expect(error.code).toBe(Code.NetworkBlocked)
        expect(calls).toEqual([])
      })
    } finally {
      unblockNetwork()
    }
  })

  // `whoami` reads an undefined answer as "the token was revoked". Swallowing the
  // refusal here would tell someone who typed `--offline` to log in again.
  test('githubLogin does not turn a refusal into "no such user"', async () => {
    const previous = process.env.RARN_NO_NETWORK
    process.env.RARN_NO_NETWORK = '1'
    try {
      await withRecordedFetch(async (calls) => {
        const error = await rejectionOf(() => githubLogin('token'))
        expect(error.code).toBe(Code.NetworkBlocked)
        expect(calls).toEqual([])
      })
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'RARN_NO_NETWORK')
      else process.env.RARN_NO_NETWORK = previous
    }
  })

  test('with the network allowed, the same calls do go out', async () => {
    const previous = process.env.RARN_NO_NETWORK
    Reflect.deleteProperty(process.env, 'RARN_NO_NETWORK')
    try {
      await withRecordedFetch(async (calls) => {
        expect(await githubLogin('token')).toBe('someone')
        expect(calls).toEqual(['https://api.github.com/user'])
      })
    } finally {
      if (previous !== undefined) process.env.RARN_NO_NETWORK = previous
    }
  })
})

/**
 * What Bun's fetch rejects with when nothing answers — measured on Bun 1.3.14 against a
 * closed local port. Not a RarnError, which is the point: it is the failure
 * `githubLogin` has to translate itself, and the one it used to swallow.
 */
function refused(): Error {
  return Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  })
}

/** Network allowed, with the global fetch answering every request through `answer`. */
async function online<T>(answer: () => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const previous = process.env.RARN_NO_NETWORK
  const original = globalThis.fetch
  Reflect.deleteProperty(process.env, 'RARN_NO_NETWORK')
  globalThis.fetch = answer as unknown as typeof globalThis.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
    if (previous !== undefined) process.env.RARN_NO_NETWORK = previous
  }
}

// `whoami` reads undefined as "the token was revoked", so undefined may only mean
// that. A lookup that failed is not an answer, and reading it as one told a reader
// with a dead connection — or a GitHub having a bad minute — to log in again.
describe('githubLogin tells a failed lookup from an answer', () => {
  test('a connection that could not be made rejects, rather than naming nobody', async () => {
    const error = await online(
      () => Promise.reject(refused()),
      () => rejectionOf(() => githubLogin('token')),
    )
    expect(error).toBeInstanceOf(RegistryError)
    expect(error.code).toBe(Code.RegistryUnreachable)
  })

  test.each([
    [500, 'Internal Server Error'],
    [502, 'Bad Gateway'],
    [503, 'Service Unavailable'],
    [403, 'API rate limit exceeded'],
    [429, 'API rate limit exceeded'],
  ])('GitHub answering %d is a failure, not a revoked token', async (status, message) => {
    const error = await online(
      () => Promise.resolve(Response.json({ message }, { status })),
      () => rejectionOf(() => githubLogin('token')),
    )
    expect(error).toBeInstanceOf(RegistryError)
    expect(error.code).toBe(Code.RegistryBadResponse)
    expect(error.what).toContain(String(status))
  })

  // Measured against api.github.com: a token it does not recognise gets 401
  // `Bad credentials`, and that is the one status read as a verdict on the token.
  test('401 is the one answer that means the token is no good', async () => {
    const who = await online(
      () => Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 })),
      () => githubLogin('token'),
    )
    expect(who).toBeUndefined()
  })
})

/**
 * The commands read the token from disk, so the file is moved somewhere disposable —
 * by `RARN_AUTH_FILE`, for the reason `authFilePath` gives. Moving HOME and USERPROFILE
 * instead would redirect nothing outside Windows: on Linux and macOS the suite would
 * replace the real `~/.rarn/auth.json` on every run, and still pass, because it would
 * read back the file it had just written.
 *
 * The path is asserted before anything is written, so a redirect that stops reaching
 * `authFilePath` fails here instead of logging whoever runs the suite out.
 */
async function withAuthFile<T>(run: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'rarn-auth-'))
  // One level down, as `~/.rarn` is, so the directory is one the code has to create.
  const file = join(root, '.rarn', 'auth.json')
  const saved = process.env.RARN_AUTH_FILE
  process.env.RARN_AUTH_FILE = file
  try {
    expect(authFilePath()).toBe(file)
    await writeToken(DEFAULT_API_URL, 'stored-token')
    expect(await readFile(file, 'utf8')).toContain('stored-token')
    return await run()
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, 'RARN_AUTH_FILE')
    else process.env.RARN_AUTH_FILE = saved
    await rm(root, { recursive: true, force: true })
  }
}

describe('where the token lives', () => {
  test('RARN_AUTH_FILE wins, so the tests never touch a real login', () => {
    expect(authFilePath({ RARN_AUTH_FILE: join('custom', 'auth.json') })).toBe(
      join('custom', 'auth.json'),
    )
  })

  test('without it, or with it empty, the token lives in the home directory', () => {
    const home = join(homedir(), '.rarn', 'auth.json')
    expect(authFilePath({})).toBe(home)
    expect(authFilePath({ RARN_AUTH_FILE: '' })).toBe(home)
  })
})

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

const registry = createRegistryClient({ apiUrl: DEFAULT_API_URL })

describe('whoami', () => {
  test('an unreachable GitHub is reported as the network, not as a revoked token', async () => {
    const error = await withAuthFile(() =>
      online(
        () => Promise.reject(refused()),
        () => rejectionOf(() => whoami({ cwd: '.' }, registry)),
      ),
    )
    expect(error.code).toBe(Code.RegistryUnreachable)
    expect(error.how).not.toContain('rarn login')
  })

  test('a token GitHub refuses is reported as one that no longer works', async () => {
    const error = await withAuthFile(() =>
      online(
        () => Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 })),
        () => rejectionOf(() => whoami({ cwd: '.' }, registry)),
      ),
    )
    expect(error.code).toBe(Code.NotLoggedIn)
    expect(error.what).toContain('no longer valid')
  })
})

describe('login', () => {
  // Unlike `whoami`, the name is decoration here: the token is already saved, and a
  // lookup that fails must not turn a login that worked into one that did not.
  test('an existing login is still reported when the name cannot be looked up', async () => {
    const printed = await withAuthFile(() =>
      online(
        () => Promise.reject(refused()),
        () => stdoutOf(() => login({ cwd: '.' }, registry)),
      ),
    )
    expect(printed).toContain('already logged in')
  })
})
