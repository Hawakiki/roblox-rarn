import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneInto } from '../src/project/prune.ts'
import { findModuleRoot } from '../src/project/rojo.ts'
import { pathExists } from '../src/util/fs.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-prune-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Lays out an extracted archive from a path -> contents map. */
async function archive(files: Record<string, string>): Promise<string> {
  const root = join(dir, 'extracted')
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, body)
  }
  await mkdir(root, { recursive: true })
  return root
}

const project = (path: string, name = 'pkg') => JSON.stringify({ name, tree: { $path: path } })

describe('findModuleRoot', () => {
  // The shape every package sampled from the live registry actually uses.
  test('reads $path from a simple project file', async () => {
    const root = await archive({
      'default.project.json': project('lib'),
      'lib/init.lua': 'return 1',
      'docs/guide.md': '# docs',
    })
    expect(await findModuleRoot(root)).toMatchObject({
      path: 'lib',
      kind: 'directory',
      source: 'project-file',
    })
  })

  // red-blox/signal points $path at Signal.luau. Assuming a directory would install
  // nothing at all.
  test('recognizes a $path that names a file', async () => {
    const root = await archive({
      'default.project.json': project('Signal.luau'),
      'Signal.luau': 'return 1',
    })
    expect(await findModuleRoot(root)).toMatchObject({ path: 'Signal.luau', kind: 'file' })
  })

  // Half the sampled packages have no project file — they set `include` when
  // publishing, so the archive root already is the module. Warning here would print
  // a warning on half of all installs.
  test('a missing project file is normal, not a fallback', async () => {
    const root = await archive({ 'init.lua': 'return 1', 'wally.toml': '' })
    const result = await findModuleRoot(root)
    expect(result).toMatchObject({ path: '', kind: 'directory', source: 'archive-root' })
    expect(result.note).toBeUndefined()
  })

  test.each([
    ['invalid JSON', '{ not json'],
    ['no tree', JSON.stringify({ name: 'pkg' })],
    ['no $path', JSON.stringify({ name: 'pkg', tree: {} })],
    ['$path is not a string', JSON.stringify({ name: 'pkg', tree: { $path: 42 } })],
  ])('falls back with a note when the project file has %s', async (_label, body) => {
    const root = await archive({ 'default.project.json': body, 'init.lua': 'return 1' })
    const result = await findModuleRoot(root)
    expect(result.source).toBe('fallback')
    expect(result.note).toBeDefined()
  })

  // Half-interpreting a rich project file would install something subtly wrong.
  // Declining and copying whole is what Wally does for every package anyway.
  test('declines a project file with nested nodes', async () => {
    const root = await archive({
      'default.project.json': JSON.stringify({
        name: 'pkg',
        tree: { $path: 'src', Extra: { $path: 'other' } },
      }),
      'src/init.lua': 'return 1',
    })
    const result = await findModuleRoot(root)
    expect(result.source).toBe('fallback')
    expect(result.note).toContain('Extra')
  })

  test('declines $className, which changes what the tree becomes', async () => {
    const root = await archive({
      'default.project.json': JSON.stringify({
        name: 'pkg',
        tree: { $className: 'Folder', $path: 'src' },
      }),
      'src/init.lua': 'return 1',
    })
    expect((await findModuleRoot(root)).source).toBe('fallback')
  })

  // A project file is package-supplied data and gets the same escape check archive
  // entries get.
  test('refuses a $path that escapes the package', async () => {
    const root = await archive({
      'default.project.json': project('../../elsewhere'),
      'init.lua': 'return 1',
    })
    const result = await findModuleRoot(root)
    expect(result.source).toBe('fallback')
    expect(result.note).toContain('outside the package')
  })

  test('falls back when $path names something the archive lacks', async () => {
    const root = await archive({ 'default.project.json': project('nope'), 'init.lua': 'x' })
    const result = await findModuleRoot(root)
    expect(result.source).toBe('fallback')
    expect(result.note).toContain('does not contain')
  })

  test('accepts a ./-prefixed path', async () => {
    const root = await archive({ 'default.project.json': project('./lib'), 'lib/init.lua': 'x' })
    expect((await findModuleRoot(root)).path).toBe('lib')
  })
})

describe('pruneInto', () => {
  // The promise case, scaled down: the module is one file inside a large archive.
  test('installs only the module tree', async () => {
    const root = await archive({
      'default.project.json': project('lib'),
      'lib/init.lua': 'return 1',
      'docs/a.md': 'x',
      'docs/b.md': 'x',
      'modules/vendored/thing.lua': 'x',
      'CHANGELOG.md': 'x',
    })

    const result = await pruneInto(root, join(dir, 'out', 'promise'), 'pkg@1.0.0')
    expect(result.archiveFiles).toBe(6)
    expect(result.installedFiles).toBe(1)
    expect(await readFile(join(result.destination, 'init.lua'), 'utf8')).toBe('return 1')
    expect(await pathExists(join(result.destination, 'docs'))).toBe(false)
  })

  // Without this, `require(_Index[...].promise)` lands on a Folder rather than a
  // ModuleScript — the reason pruning is a correctness fix, not an optimization.
  test('puts the module at the destination root, not one level down', async () => {
    const root = await archive({ 'default.project.json': project('lib'), 'lib/init.lua': 'x' })
    const result = await pruneInto(root, join(dir, 'out', 'promise'), 'pkg@1.0.0')

    expect(await pathExists(join(result.destination, 'init.lua'))).toBe(true)
    expect(await pathExists(join(result.destination, 'lib'))).toBe(false)
  })

  test('a file module becomes a file with its extension, not a directory', async () => {
    const root = await archive({
      'default.project.json': project('Signal.luau'),
      'Signal.luau': 'return 1',
    })
    const result = await pruneInto(root, join(dir, 'out', 'signal'), 'pkg@1.0.0')

    expect(result.destination.endsWith('signal.luau')).toBe(true)
    expect((await stat(result.destination)).isFile()).toBe(true)
    expect(await readFile(result.destination, 'utf8')).toBe('return 1')
    expect(result.installedFiles).toBe(1)
  })

  test('copies the whole archive when there is no project file', async () => {
    const root = await archive({ 'init.lua': 'return 1', 'KnitServer.lua': 'return 2' })
    const result = await pruneInto(root, join(dir, 'out', 'knit'), 'pkg@1.0.0')

    expect(result.root.source).toBe('archive-root')
    expect(await readFile(join(result.destination, 'KnitServer.lua'), 'utf8')).toBe('return 2')
  })

  test('nested directories survive the copy', async () => {
    const root = await archive({
      'default.project.json': project('src'),
      'src/init.lua': 'x',
      'src/deep/nested/thing.luau': 'deep',
    })
    const result = await pruneInto(root, join(dir, 'out', 'pkg'), 'pkg@1.0.0')
    expect(await readFile(join(result.destination, 'deep', 'nested', 'thing.luau'), 'utf8')).toBe(
      'deep',
    )
  })

  // An unreadable project file must not stop the install.
  test('a broken project file still installs, whole', async () => {
    const root = await archive({ 'default.project.json': '{ broken', 'init.lua': 'return 1' })
    const result = await pruneInto(root, join(dir, 'out', 'pkg'), 'pkg@1.0.0')

    expect(result.root.source).toBe('fallback')
    expect(await readFile(join(result.destination, 'init.lua'), 'utf8')).toBe('return 1')
  })

  test('reports the saving so it can be shown', async () => {
    const root = await archive({
      'default.project.json': project('lib'),
      'lib/a.lua': 'x',
      'lib/b.lua': 'x',
      'junk/1': 'x',
      'junk/2': 'x',
      'junk/3': 'x',
    })
    const result = await pruneInto(root, join(dir, 'out', 'pkg'), 'pkg@1.0.0')
    expect(result.archiveFiles).toBe(6)
    expect(result.installedFiles).toBe(2)
  })

  test('overwrites an existing destination', async () => {
    const root = await archive({ 'default.project.json': project('lib'), 'lib/init.lua': 'new' })
    const out = join(dir, 'out', 'pkg')
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'init.lua'), 'old')

    const result = await pruneInto(root, out, 'pkg@1.0.0')
    expect(await readFile(join(result.destination, 'init.lua'), 'utf8')).toBe('new')
  })
})
