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

  // Nobody is there to answer when stdin is not a terminal, and `--yes` already
  // describes exactly what a non-interactive caller wants. So the choice is between
  // failing in order to teach the flag and doing the obvious thing, and the obvious
  // thing costs a printed line.
  //
  // What it replaces is worth naming: this used to print half a prompt, write no
  // file, say nothing, and exit 0 — indistinguishable from having worked.
  const interactive = !options.yes && process.stdin.isTTY
  const answers = interactive ? await prompt(dir) : defaults(dir)

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
      options.yes || interactive
        ? null
        : chalk.dim(`stdin is not a terminal — using defaults, as ${chalk.cyan('--yes')} would`),
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
 * It also decides whether `place` can be derived at all, which is where the cost
 * stops being hypothetical: with no project file to read from, the first cross-realm
 * dependency fails with RN0031 and the person has to work out what to write.
 *
 * **A directory with no project file gets this advice too**, and that is the whole
 * point of the change — it is the case with the least to go on, and it used to be
 * the only case that got nothing. `install` still says nothing there, correctly: a
 * project may be a library, whose realm directories no place is supposed to mount.
 * At `init` the person is starting a project, so the advice has somewhere to land.
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
  if (scan.found.has(DEFAULT_PACKAGE_DIR) || scan.disputed.has(DEFAULT_PACKAGE_DIR)) return []

  const headline = scan.scanned
    ? `no Rojo project file puts ${DEFAULT_PACKAGE_DIR}/ anywhere yet.`
    : `no Rojo project file here yet. When you add one, give it ${DEFAULT_PACKAGE_DIR}/.`

  return [
    '',
    `${chalk.yellow('note')} ${headline}`,
    chalk.dim('  Rojo syncs only what the project file names, so add something like:'),
    '',
    chalk.dim(rojoSnippet(DEFAULT_PACKAGE_DIR, 'ReplicatedStorage')),
    '',
    chalk.dim(`  Rarn reads it back to work out where ${DEFAULT_PACKAGE_DIR}/ lands in the`),
    chalk.dim('  DataModel, which is what a server or dev package needs to reach a shared one.'),
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

  // A question whose input ends first — Ctrl+D — never settles. Without this the
  // event loop simply drains and the process exits 0, having printed a prompt and
  // written nothing, which is the one outcome indistinguishable from success.
  const ended = new AbortController()
  rl.once('close', () => {
    ended.abort()
  })

  try {
    const ask = async (label: string, fallback: string): Promise<string> => {
      const suffix = fallback === '' ? '' : chalk.dim(` (${fallback})`)
      const answer = await rl.question(`${label}${suffix}: `, { signal: ended.signal })
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
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RarnError({
        code: Code.PromptAborted,
        what: `${MANIFEST_FILE_NAME} was not created: the input ended before the questions were answered.`,
        how: 'Run `rarn init --yes` to accept the defaults without being asked.',
      })
    }
    throw error
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
