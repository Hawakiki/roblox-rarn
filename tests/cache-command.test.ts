import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeIntegrity } from '../src/cache/integrity.ts'
import { cache } from '../src/cli/commands/cache.ts'
import { Code } from '../src/util/codes.ts'
import type { RarnError } from '../src/util/errors.ts'
import { pathExists } from '../src/util/fs.ts'

/**
 * `rarn cache` is the other command that carries its behaviour in `cli/` rather than
 * in a layer, and it was the other one with no tests — which is how it kept the
 * defect `init` had already been fixed for.
 *
 * Two things are being pinned here, and neither is exotic. One is running a
 * destructive command with stdin redirected, which is what every script does. The
 * other is that `--json` and the human output agree about whether the command
 * failed: the JSON form is the one a caller parses, and it was the one that said
 * everything was fine.
 */

let root: string
let project: string
let previousCacheDir: string | undefined
let previousExitCode: typeof process.exitCode

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarn-cache-cmd-'))
  project = await mkdtemp(join(tmpdir(), 'rarn-cache-proj-'))

  previousCacheDir = process.env.RARN_CACHE_DIR
  process.env.RARN_CACHE_DIR = root

  // Reset with 0 rather than undefined. Measured on Bun 1.3.14: assigning
  // `undefined` leaves the previous value in place, so a test that set 1 hands 1 to
  // the next one — which passed this file's own --json test before the fix it was
  // written to catch. A test that passes for the wrong reason is the failure mode
  // this whole audit is about, so it gets a comment rather than a quiet `?? 0`.
  previousExitCode = process.exitCode
  process.exitCode = 0
})

afterEach(async () => {
  process.exitCode = previousExitCode ?? 0
  // `Reflect.deleteProperty` rather than an assignment, for the reason
  // `registry.test.ts` writes down at its own restore: `process.env.X = undefined`
  // stores the *string* "undefined", which is a set variable rather than an unset one.
  if (previousCacheDir === undefined) Reflect.deleteProperty(process.env, 'RARN_CACHE_DIR')
  else process.env.RARN_CACHE_DIR = previousCacheDir

  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

async function run(
  action: 'dir' | 'clean' | 'verify',
  options: { json?: boolean; yes?: boolean } = {},
): Promise<string> {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk))
    return true
  }

  try {
    await cache({ cwd: project, action, ...options })
  } finally {
    process.stdout.write = original
  }

  return written.join('').replaceAll(ANSI, '')
}

/** A cache entry that exists on both sides, so it is not read as an orphan. */
async function seed(key: string, bytes: string): Promise<void> {
  await mkdir(join(root, 'downloads'), { recursive: true })
  await mkdir(join(root, 'extracted', key), { recursive: true })
  await writeFile(join(root, 'downloads', `${key}.zip`), bytes)
  await writeFile(join(root, 'extracted', key, 'init.luau'), 'return {}')
}

/**
 * A lockfile is what turns `verify` from a structure check into a digest check, so
 * the digest here is deliberately not the one `seed` writes.
 */
async function lockfileWith(key: string, integrity: string): Promise<void> {
  await writeFile(
    join(project, 'rarn.lock'),
    `${JSON.stringify(
      {
        lockfileVersion: 1,
        packages: {
          '@evaera/promise@4.0.0': {
            indexDir: key,
            integrity,
            realm: 'shared',
            resolved: 'https://api.wally.run/v1/package-contents/evaera/promise/4.0.0',
            version: '4.0.0',
          },
        },
        registry: 'https://api.wally.run/',
        root: { registry: 'https://github.com/UpliftGames/wally-index' },
      },
      null,
      2,
    )}\n`,
  )
}

const WRONG_DIGEST = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('clean, with nobody there to answer', () => {
  /**
   * `bun test` attaches no terminal, so this is the real condition rather than a
   * simulated one — the same way `init.test.ts` reaches its own.
   */
  test('refuses rather than asking a question nobody can hear', async () => {
    await seed('evaera_promise@4.0.0', 'some bytes')

    const error = (await run('clean').catch((e: unknown) => e)) as RarnError
    expect(error.code).toBe(Code.PromptAborted)
    expect(error.how).toContain('--yes')
  })

  /**
   * The point of refusing. Deleting is the direction that costs something: every
   * project on the machine goes back to the network for its next install.
   */
  test('leaves the cache where it was', async () => {
    await seed('evaera_promise@4.0.0', 'some bytes')

    await run('clean').catch(() => undefined)

    expect(await pathExists(join(root, 'downloads', 'evaera_promise@4.0.0.zip'))).toBe(true)
    expect(await pathExists(join(root, 'extracted', 'evaera_promise@4.0.0'))).toBe(true)
  })

  test('--yes deletes, being the answer the flag exists to give', async () => {
    await seed('evaera_promise@4.0.0', 'some bytes')

    const output = await run('clean', { yes: true })

    expect(output).toContain('cleaned')
    expect(await pathExists(root)).toBe(false)
  })

  /**
   * An empty cache is not a failure. A script that cleans before every run would
   * otherwise fail on its second run, having succeeded on its first.
   */
  test('an already-empty cache says so instead of refusing', async () => {
    expect(await run('clean')).toContain('already empty')
  })
})

describe('verify agrees with itself across both forms', () => {
  test('a digest mismatch fails the command', async () => {
    await seed('evaera_promise@4.0.0', 'not the bytes the lockfile pinned')
    await lockfileWith('evaera_promise@4.0.0', WRONG_DIGEST)

    const output = await run('verify')

    expect(output).toContain('digest mismatch')
    expect(process.exitCode).toBe(1)
  })

  /**
   * The defect this file was written for. The body named the mismatch and the exit
   * code said success, so a caller that parsed the output correctly and checked the
   * status — the two things a script is supposed to do — was told nothing happened.
   */
  test('--json fails it too, being the form a script reads', async () => {
    await seed('evaera_promise@4.0.0', 'not the bytes the lockfile pinned')
    await lockfileWith('evaera_promise@4.0.0', WRONG_DIGEST)

    const output = await run('verify', { json: true })

    expect(JSON.parse(output)).toMatchObject({ mismatched: ['@evaera/promise@4.0.0'] })
    expect(process.exitCode).toBe(1)
  })

  test('matching bytes verify and pass', async () => {
    const bytes = 'the bytes the lockfile pinned'
    await seed('evaera_promise@4.0.0', bytes)
    await lockfileWith('evaera_promise@4.0.0', computeIntegrity(new TextEncoder().encode(bytes)))

    const output = await run('verify', { json: true })

    expect(JSON.parse(output)).toMatchObject({
      mismatched: [],
      verified: ['@evaera/promise@4.0.0'],
    })
    expect(process.exitCode).toBe(0)
  })

  /**
   * An orphan is an interrupted or hand-edited cache, not an attack, and everything
   * in it is regenerable — so it is reported without failing the command. Pinned
   * because "report more things as failures" is a tempting change to make later.
   */
  test('an orphan is reported without failing', async () => {
    await mkdir(join(root, 'downloads'), { recursive: true })
    await mkdir(join(root, 'extracted', 'tree_only@1.0.0'), { recursive: true })
    await writeFile(join(root, 'downloads', 'zip_only@1.0.0.zip'), 'x')

    const output = await run('verify', { json: true })

    expect(JSON.parse(output)).toMatchObject({
      orphanArchives: ['zip_only@1.0.0'],
      orphanTrees: ['tree_only@1.0.0'],
    })
    expect(process.exitCode).toBe(0)
  })
})
