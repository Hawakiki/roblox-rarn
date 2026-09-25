import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { clearToken, readToken, requireToken, writeToken } from '../src/publish/auth.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'

const API = 'https://api.wally.run'

let root: string
let path: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarn-auth-'))
  // One level down, so the directory is one the code has to create.
  path = join(root, '.rarn', 'auth.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function expectRejection(fn: () => Promise<unknown>): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the call succeeded')
}

async function writeRaw(text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('token file', () => {
  test('round-trips a token and leaves nothing beside it', async () => {
    await writeToken(API, 'gho_first', path)
    await writeToken(`${API}/`, 'gho_second', path)

    expect(await readToken(API, path)).toBe('gho_second')
    expect(await readdir(dirname(path))).toEqual(['auth.json'])
  })

  test('a token for another registry survives a login and a logout', async () => {
    await writeToken('https://other.example', 'gho_other', path)
    await writeToken(API, 'gho_wally', path)
    expect(await clearToken(API, path)).toBe(true)

    expect(await readToken('https://other.example', path)).toBe('gho_other')
    expect(await readToken(API, path)).toBeUndefined()
  })
})

describe('a token file that is there but wrong', () => {
  // What `publish` receives goes out as `Authorization: Bearer <token>`. An object
  // that reached it would be sent as `Bearer [object Object]`, and the registry's
  // answer would blame the account rather than the file.
  test('a value that is not a string is never handed out as a token', async () => {
    await writeRaw(
      JSON.stringify({ tokens: { [API]: { token: 'gho_nested' }, 'https://other.example': 42 } }),
    )

    expect(await readToken(API, path)).toBeUndefined()
    expect(await readToken('https://other.example', path)).toBeUndefined()
    const error = await expectRejection(() => requireToken(API, path))
    expect(error.code).toBe(Code.NotLoggedIn)
  })

  test('a string entry beside a damaged one is still read', async () => {
    await writeRaw(JSON.stringify({ tokens: { [API]: 'gho_good', 'https://other.example': 42 } }))
    expect(await readToken(API, path)).toBe('gho_good')
  })

  // Logged out rather than an error, because the advice for both is `rarn login`,
  // and a login is what replaces the file.
  test('invalid JSON reads as logged out, and a login repairs it', async () => {
    await writeRaw('{ "tokens": { "https://api.wally.run": "gho_cut')

    expect(await readToken(API, path)).toBeUndefined()
    await writeToken(API, 'gho_fresh', path)
    expect(await readToken(API, path)).toBe('gho_fresh')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ tokens: { [API]: 'gho_fresh' } })
  })

  // A directory is the one unreadable file every platform can produce without
  // privileges. The shapes more likely in the field — a file owned by another
  // account, a Windows lock — fail the same read in the same place.
  test('a file that cannot be read is an error, not a logged-out state', async () => {
    await mkdir(path, { recursive: true })

    const read = await expectRejection(() => readToken(API, path))
    expect(read.code).toBe(Code.TokenStoreUnreadable)
    expect(read.where).toBe(path)

    // The one that matters: `logout` answering "not logged in" while the file it
    // could not read may still hold the token.
    await expectRejection(() => clearToken(API, path))
  })
})

const posix = process.platform !== 'win32'
if (!posix) {
  console.warn(
    '\n  토큰 파일 권한 검사는 Windows 에서 의미가 없어 건너뛴다. CI 의 ubuntu 잡이 실행한다.\n',
  )
}

describe.skipIf(!posix)('token file mode', () => {
  let previousUmask = 0
  let restoreChmod = (): void => undefined

  beforeEach(() => {
    // Forced, so the mode measured is the code's and not the runner's. Under a umask
    // of 0o077 even a file created with the default mode comes out owner-only, and
    // the test would pass against exactly the defect it is here to catch.
    previousUmask = process.umask(0o022)
    // Neutered, so the mode measured is the one the file was created with. A file
    // written under the default mode and tightened afterwards ends at 0600 all the
    // same — the final mode alone cannot tell it from one that was never readable
    // by anyone else, and the time in between is the whole defect.
    const chmod = spyOn(fsp, 'chmod').mockResolvedValue(undefined)
    restoreChmod = () => {
      chmod.mockRestore()
    }
  })

  afterEach(() => {
    process.umask(previousUmask)
    restoreChmod()
  })

  const mode = async (target: string): Promise<number> => (await stat(target)).mode & 0o777

  test('the token file is owner-only from the moment it exists', async () => {
    await writeToken(API, 'gho_secret', path)
    expect((await mode(path)).toString(8)).toBe('600')
  })

  test('a missing config directory is created owner-only', async () => {
    await writeToken(API, 'gho_secret', path)
    expect((await mode(dirname(path))).toString(8)).toBe('700')
  })

  test('an existing file with a wider mode is replaced, not written into', async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ tokens: {} }), { mode: 0o644 })
    expect((await mode(path)).toString(8)).toBe('644')

    await writeToken(API, 'gho_secret', path)
    expect((await mode(path)).toString(8)).toBe('600')
  })
})
