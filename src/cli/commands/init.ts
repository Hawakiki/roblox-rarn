import { appendFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import { RETIRED_PREFIX, STAGING_DIR } from '../../linker/swap.ts'
import { manifestPath, normalizeManifest, suggestPackageName } from '../../manifest/read.ts'
import {
  DEFAULT_PACKAGE_DIR,
  MANIFEST_FILE_NAME,
  type Manifest,
  type Realm,
  realmDirs,
} from '../../manifest/types.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { writeManifest } from '../../manifest/write.ts'
import { rojoSnippet, scanPlaceProject } from '../../project/place.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { isNotFoundError, pathExists } from '../../util/fs.ts'

export interface InitOptions {
  cwd: string
  yes: boolean
  force: boolean
}

export async function init(options: InitOptions): Promise<void> {
  const dir = resolve(options.cwd)
  const path = manifestPath(dir)

  if (!options.force && (await pathExists(path))) {
    throw new RarnError({
      code: Code.ManifestInvalid,
      what: `${MANIFEST_FILE_NAME} already exists.`,
      where: path,
      how: "Edit it directly, or pass --force to overwrite it. 'rarn add' is usually what you want.",
    })
  }

  const answers = options.yes ? defaults(dir) : await prompt(dir)

  // Built and validated before writing, so a bad answer fails with the same message
  // a hand-edited manifest would produce rather than writing a file that cannot load.
  const manifest: Manifest = {
    name: answers.name,
    version: answers.version,
    ...(answers.description === '' ? {} : { description: answers.description }),
    ...(answers.license === '' ? {} : { license: answers.license }),
    private: true,
    realm: answers.realm,
    packageDir: DEFAULT_PACKAGE_DIR,
    dependencies: {},
  }
  validateManifest(manifest, path)
  await writeManifest(dir, manifest)

  const ignored = await ensureGitignore(dir, DEFAULT_PACKAGE_DIR)

  process.stdout.write(
    [
      `${chalk.green('created')} ${MANIFEST_FILE_NAME}`,
      ignored ? `${chalk.green('updated')} .gitignore` : null,
      ...(await rojoAdvice(dir)),
      '',
      `Next: ${chalk.cyan('rarn add @evaera/promise')}`,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  )
}

/**
 * Tells a Rojo project what to add, at the one moment it is not yet a problem.
 *
 * An unmounted package directory produces no error anywhere: the install works, the
 * files are correct, and the packages are simply absent in Studio. Saying it here
 * costs three lines. Discovering it later costs a debugging session that starts in
 * the wrong place, because the symptom shows up in whichever script required first,
 * as `Requested module experienced an error while loading`.
 *
 * Printed, not inserted. Rewriting the project file would reorder its keys and
 * reformat it — a large edit to make on someone's behalf for something they can
 * paste in ten seconds.
 */
async function rojoAdvice(dir: string): Promise<(string | null)[]> {
  const probe = normalizeManifest({
    name: '@rarn/probe',
    version: '0.0.0',
    packageDir: DEFAULT_PACKAGE_DIR,
  })
  const scan = await scanPlaceProject(dir, probe)
  if (!scan.scanned) return []
  if (scan.found.has(DEFAULT_PACKAGE_DIR) || scan.disputed.has(DEFAULT_PACKAGE_DIR)) return []

  return [
    '',
    `${chalk.yellow('note')} no Rojo project file puts ${DEFAULT_PACKAGE_DIR}/ anywhere yet.`,
    chalk.dim('  Rojo syncs only what the project file names, so add something like:'),
    '',
    chalk.dim(rojoSnippet(DEFAULT_PACKAGE_DIR, 'ReplicatedStorage')),
  ]
}

interface Answers {
  name: string
  version: string
  description: string
  license: string
  realm: Realm
}

function defaults(dir: string): Answers {
  return {
    name: suggestPackageName(dir),
    version: '0.1.0',
    description: '',
    license: '',
    realm: 'shared',
  }
}

async function prompt(dir: string): Promise<Answers> {
  const base = defaults(dir)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const ask = async (label: string, fallback: string): Promise<string> => {
      const suffix = fallback === '' ? '' : chalk.dim(` (${fallback})`)
      const answer = await rl.question(`${label}${suffix}: `)
      return answer.trim() === '' ? fallback : answer.trim()
    }

    const name = await ask('name', base.name)
    const version = await ask('version', base.version)
    const description = await ask('description', '')
    const license = await ask('license', 'MIT')
    const realmAnswer = await ask('realm (shared/server)', 'shared')

    return {
      name,
      version,
      description,
      license,
      realm: realmAnswer === 'server' ? 'server' : 'shared',
    }
  } finally {
    rl.close()
  }
}

/**
 * Adds the install directories to `.gitignore` if a repository is present.
 *
 * All three realm directories are listed, not just the shared one, because a project
 * that later adds a server dependency would otherwise start committing packages
 * without noticing. Returns whether anything changed.
 */
async function ensureGitignore(dir: string, packageDir: string): Promise<boolean> {
  const path = join(dir, '.gitignore')

  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    // No .gitignore and no repository means there is nothing to ignore for.
    if (!(await pathExists(join(dir, '.git')))) return false
    if (!isNotFoundError(error)) return false
  }

  const dirs = realmDirs(packageDir)
  // The staging directories are transient — the next install clears whatever an
  // interrupted one left — but "the next install" can be days away, and in between
  // is exactly when someone commits a half-built tree without noticing it is there.
  const wanted = [
    `${dirs.shared}/`,
    `${dirs.server}/`,
    `${dirs.dev}/`,
    `${STAGING_DIR}/`,
    `${RETIRED_PREFIX}*/`,
  ]
  const existing = new Set(current.split('\n').map((line) => line.trim()))
  const missing = wanted.filter((entry) => !existing.has(entry))
  if (missing.length === 0) return false

  const prefix = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(path, `${prefix}\n# Rarn\n${missing.join('\n')}\n`, 'utf8')
  return true
}
