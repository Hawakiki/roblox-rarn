import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init } from '../src/cli/commands/init.ts'
import type { RarnError } from '../src/util/errors.ts'

/**
 * `rarn init` had no tests at all, which is how both of the defects here shipped.
 *
 * Neither is exotic. One is running the command with stdin redirected — the shape
 * every script and every CI job takes — and the other is running it in an empty
 * directory, which is the only state a first `rarn init` is ever in.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-init-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Chalk colours whatever the terminal will take, and the assertions read the words. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Runs init with output captured, since most of what it does is print. */
async function run(options: { yes?: boolean; force?: boolean } = {}): Promise<string> {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk))
    return true
  }

  try {
    await init({ cwd: dir, yes: options.yes ?? false, force: options.force ?? false })
  } finally {
    process.stdout.write = original
  }

  return written.join('').replaceAll(ANSI, '')
}

const manifest = async () => JSON.parse(await readFile(join(dir, 'rarn.json'), 'utf8')) as unknown

describe('a non-interactive stdin', () => {
  /**
   * `bun test` does not attach a terminal, so this is the real condition rather than
   * a simulated one. What it used to produce: half a prompt, no file, nothing printed,
   * and exit 0 — the one failure indistinguishable from having worked.
   */
  test('writes the manifest instead of half-asking and giving up', async () => {
    const output = await run()

    expect(await manifest()).toMatchObject({ version: '0.1.0', private: true, realm: 'shared' })
    expect(output).toContain('created rarn.json')
  })

  test('says it used the defaults, so the run is not silently different', async () => {
    expect(await run()).toContain('not a terminal')
  })

  test('--yes says nothing about it, having been told', async () => {
    expect(await run({ yes: true })).not.toContain('not a terminal')
  })
})

describe('the Rojo note', () => {
  /**
   * The case with the least to go on used to be the only one that got no advice.
   *
   * Walked in the field, in this order: `rarn init` in an empty directory (silence),
   * then `rarn add -D`, which failed with RN0031 because there was still no project
   * file to derive `place` from. The three lines below are what the whole detour was
   * about.
   */
  test('an empty directory gets it', async () => {
    const output = await run({ yes: true })

    expect(output).toContain('no Rojo project file here yet')
    expect(output).toContain('"RARN_MODULE": { "$path": "RARN_MODULE" }')
  })

  test('a project file that mounts nothing gets it, worded for that', async () => {
    await writeFile(
      join(dir, 'default.project.json'),
      JSON.stringify({ name: 'x', tree: { $className: 'DataModel' } }),
    )

    const output = await run({ yes: true })
    expect(output).toContain('puts RARN_MODULE/ anywhere yet')
  })

  test('a project file that already mounts the directory gets nothing', async () => {
    await writeFile(
      join(dir, 'default.project.json'),
      JSON.stringify({
        name: 'x',
        tree: {
          $className: 'DataModel',
          ReplicatedStorage: { RARN_MODULE: { $path: 'RARN_MODULE' } },
        },
      }),
    )

    expect(await run({ yes: true })).not.toContain('Rojo')
  })
})

describe('refusing to overwrite', () => {
  test('an existing manifest stops the run', async () => {
    await run({ yes: true })
    const error = (await run({ yes: true }).catch((e: unknown) => e)) as RarnError
    expect(error.code).toBe('RN0012')
  })

  test('--force replaces it', async () => {
    await writeFile(join(dir, 'rarn.json'), '{ "name": "old", "version": "9.9.9" }')
    await run({ yes: true, force: true })
    expect(await manifest()).toMatchObject({ version: '0.1.0' })
  })
})
