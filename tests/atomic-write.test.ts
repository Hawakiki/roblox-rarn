import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeManifest } from '../src/manifest/read.ts'
import { serializeManifest } from '../src/manifest/write.ts'
import { collect } from '../src/publish/pack.ts'
import { ATOMIC_TEMP_SUFFIX, writeFileAtomic } from '../src/util/atomic-write.ts'

const windows = process.platform === 'win32'

/** Windows needs Developer Mode or an elevated shell to create one. */
function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'rarn-symlink-'))
  try {
    writeFileSync(join(probe, 'target'), '')
    symlinkSync(join(probe, 'target'), join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

const symlinks = canSymlink()
if (!symlinks) {
  console.warn(
    '\n  심볼릭 링크를 만들 수 없어 링크 추적 검사를 건너뛴다 (Windows 는 개발자 모드 필요).\n',
  )
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-atomic-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  test('replaces the content of an existing file', async () => {
    const path = join(dir, 'rarn.json')
    await writeFile(path, 'old')
    await writeFileAtomic(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['rarn.json'])
  })

  test('creates a file that was not there', async () => {
    const path = join(dir, 'rarn.lock')
    await writeFileAtomic(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')
  })

  // The rename is the one step that touches the target, so a failure there is the
  // last point at which the old content could be lost — and the temp file already
  // exists, so it is also the step that has something to clean up.
  test('a failed rename leaves the target whole and no temp file behind', async () => {
    const path = join(dir, 'rarn.json')
    await writeFile(path, 'old')

    const failing = spyOn(fsp, 'rename').mockImplementation(() =>
      Promise.reject(Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })),
    )
    const started = performance.now()
    try {
      const error = await writeFileAtomic(path, 'new').catch((e: unknown) => e)
      expect((error as { code?: string }).code).toBe('EIO')
      expect(failing).toHaveBeenCalled()
    } finally {
      failing.mockRestore()
    }
    // Only "someone has it open" is worth waiting out. Retrying this too would still end
    // in the same error, just a second later, so the time is the only thing that shows it.
    expect(performance.now() - started).toBeLessThan(500)

    expect(await readFile(path, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['rarn.json'])
  })

  // Root may write anything, so the refusal this checks does not exist for it.
  test.skipIf(process.getuid?.() === 0)(
    'a read-only file is refused, as writing in place refused it',
    async () => {
      const path = join(dir, 'rarn.json')
      await writeFile(path, 'old')
      await chmod(path, 0o444)
      try {
        const error = await writeFileAtomic(path, 'new').catch((e: unknown) => e)
        expect(['EACCES', 'EPERM']).toContain((error as { code?: string }).code ?? '')
        expect(await readFile(path, 'utf8')).toBe('old')
        expect(await readdir(dir)).toEqual(['rarn.json'])
      } finally {
        await chmod(path, 0o644)
      }
    },
  )

  // Windows keeps one read-only bit, not a mode, so there is nothing further to keep.
  test.skipIf(windows)('the permission bits survive the replacement', async () => {
    const path = join(dir, 'rarn.json')
    await writeFile(path, 'old')
    await chmod(path, 0o664)
    await writeFileAtomic(path, 'new')
    expect((await stat(path)).mode & 0o777).toBe(0o664)
  })

  test.skipIf(!symlinks)('a symlink is followed rather than replaced', async () => {
    const real = join(dir, 'shared.json')
    const link = join(dir, 'rarn.json')
    await writeFile(real, 'old')
    await symlink(real, link)

    await writeFileAtomic(link, 'new')

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('new')
  })

  // `realpath` gives up on a link whose target is not there yet. Writing in place created
  // that target and kept the link; so must this. The target is relative, so it has to be
  // read against the link's directory rather than the working one.
  test.skipIf(!symlinks)('a symlink whose target does not exist yet is followed', async () => {
    const link = join(dir, 'rarn.lock')
    await symlink('shared.lock', link)

    await writeFileAtomic(link, 'new')

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(dir, 'shared.lock'), 'utf8')).toBe('new')
    expect((await readdir(dir)).sort()).toEqual(['rarn.lock', 'shared.lock'])
  })

  // Following links by hand must still end somewhere. Writing in place refused a cycle
  // with ELOOP; renaming over one of its links would quietly break it instead.
  test.skipIf(!symlinks)('a symlink cycle is refused, not renamed over', async () => {
    const link = join(dir, 'rarn.lock')
    const other = join(dir, 'other.lock')
    await symlink(other, link)
    await symlink(link, other)

    const error = await writeFileAtomic(link, 'new').catch((e: unknown) => e)

    expect((error as { code?: string }).code).toBe('ELOOP')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect((await readdir(dir)).sort()).toEqual(['other.lock', 'rarn.lock'])
  })

  // Windows refuses to replace a file anything holds open, even for reading, where
  // writing in place did not care. On Windows this goes through the retry; elsewhere
  // the rename is unaffected and it passes on the first attempt.
  test('a reader holding the file for a moment does not fail the write', async () => {
    const path = join(dir, 'rarn.lock')
    await writeFile(path, 'old')
    const reader = await open(path, 'r')
    const released = new Promise<void>((resolve) => {
      setTimeout(() => {
        void reader.close().then(resolve)
      }, 150)
    })

    const started = performance.now()
    try {
      await writeFileAtomic(path, 'new')
    } finally {
      await released
    }

    expect(await readFile(path, 'utf8')).toBe('new')
    if (windows) expect(performance.now() - started).toBeGreaterThanOrEqual(100)
    expect(await readdir(dir)).toEqual(['rarn.lock'])
  })

  // This is a trade, and both halves are asserted so that neither can be forgotten: the
  // atomic write gives up and leaves the target whole, and the in-place write it replaced
  // goes through under the very same holder — which, like any Node or Bun reader, lets
  // others write.
  test.skipIf(!windows)(
    'a holder that keeps the file past the window fails the write, where writing in place did not',
    async () => {
      const path = join(dir, 'rarn.lock')
      await writeFile(path, 'old')
      const holder = await open(path, 'r')

      try {
        const started = performance.now()
        const error = await writeFileAtomic(path, 'new').catch((e: unknown) => e)
        expect((error as { code?: string }).code).toBe('EPERM')
        expect(performance.now() - started).toBeGreaterThanOrEqual(1_000)
        expect(await readFile(path, 'utf8')).toBe('old')
        expect(await readdir(dir)).toEqual(['rarn.lock'])

        await writeFile(path, 'in place', 'utf8')
        expect(await readFile(path, 'utf8')).toBe('in place')
      } finally {
        await holder.close()
      }
    },
  )
})

describe('an interrupted write', () => {
  // Ctrl+C and a killed terminal both end the process where it stands: no `catch`, no
  // `finally`. So this is the one case the in-process tests cannot stand in for. The
  // child writes part of the content, says so, and waits to be killed mid-write.
  test('leaves the previous rarn.json whole, and what it leaves is never published', async () => {
    const path = join(dir, 'rarn.json')
    const original = serializeManifest({ name: '@me/game', version: '0.1.0' })
    await writeFile(path, original)

    const writer = pathToFileURL(join(import.meta.dir, '../src/manifest/write.ts')).href
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
        const fsp = require('node:fs/promises')
        const real = fsp.writeFile
        fsp.writeFile = async (target, data, options) => {
          await real(target, String(data).slice(0, 16), options)
          process.stdout.write('ready\\n')
          await new Promise(() => {})
        }
        const { writeManifest } = await import(${JSON.stringify(writer)})
        await writeManifest(${JSON.stringify(dir)}, {
          name: '@me/game',
          version: '0.2.0',
          dependencies: { '@evaera/promise': '^4.0.0' },
        })
        `,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    const { value } = await child.stdout.getReader().read()
    child.kill('SIGKILL')
    await child.exited
    // A child that never got as far as writing leaves the file whole too, which would
    // pass every assertion below for the wrong reason.
    if (!new TextDecoder().decode(value).includes('ready')) {
      throw new Error(`the writer never started: ${await new Response(child.stderr).text()}`)
    }

    expect(await readFile(path, 'utf8')).toBe(original)

    const leftovers = (await readdir(dir)).filter((name) => name !== 'rarn.json')
    expect(leftovers).toHaveLength(1)
    expect(leftovers[0]?.endsWith(ATOMIC_TEMP_SUFFIX)).toBe(true)
    expect(await collect(dir, normalizeManifest({ name: '@me/game', version: '0.1.0' }))).toEqual([
      'rarn.json',
    ])
  })
})
