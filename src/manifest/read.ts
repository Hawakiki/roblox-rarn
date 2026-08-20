import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { isNotFoundError } from '../util/fs.ts'
import {
  DEFAULT_PACKAGE_DIR,
  DEFAULT_REALM,
  DEFAULT_REGISTRY,
  MANIFEST_FILE_NAME,
  type Manifest,
  type NormalizedManifest,
} from './types.ts'
import { validateManifest } from './validate.ts'

/** Absolute path to the manifest for a project directory. */
export function manifestPath(dir: string): string {
  return join(resolve(dir), MANIFEST_FILE_NAME)
}

/** Reads and validates `rarn.json`, with defaults applied. */
export async function readManifest(dir: string): Promise<NormalizedManifest> {
  const path = manifestPath(dir)
  return normalizeManifest(validateManifest(await readManifestJson(path), path))
}

/** Reads the manifest without applying defaults, for commands that rewrite it. */
export async function readManifestRaw(dir: string): Promise<Manifest> {
  const path = manifestPath(dir)
  return validateManifest(await readManifestJson(path), path)
}

async function readManifestJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if (isNotFoundError(cause)) {
      throw new RarnError({
        code: Code.ManifestNotFound,
        what: `No ${MANIFEST_FILE_NAME} found.`,
        where: path,
        how: `Run 'rarn init' to create one, or use --cwd to point at the right directory.`,
        cause,
      })
    }
    throw new RarnError({
      code: Code.ManifestUnreadable,
      what: `Could not read ${MANIFEST_FILE_NAME}.`,
      where: path,
      how: 'Check the file permissions.',
      cause,
    })
  }

  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new RarnError({
      code: Code.ManifestUnreadable,
      what: `${MANIFEST_FILE_NAME} is not valid JSON.`,
      where: path,
      detail: cause instanceof Error ? `  ${cause.message}` : undefined,
      how: 'Fix the syntax error. A trailing comma or an unquoted key is the usual cause.',
      cause,
    })
  }
}

/**
 * Fills in every default so downstream layers never have to know what a default is.
 *
 * `realm` deliberately does not default `place`: an absent place path is only an
 * error when a cross-realm link actually needs it, and deciding that here would
 * reject projects that never cross realms at all.
 */
export function normalizeManifest(manifest: Manifest): NormalizedManifest {
  return {
    ...manifest,
    realm: manifest.realm ?? DEFAULT_REALM,
    registry: manifest.registry ?? DEFAULT_REGISTRY,
    packageDir: manifest.packageDir ?? DEFAULT_PACKAGE_DIR,
    private: manifest.private ?? false,
    place: manifest.place ?? {},
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
    serverDependencies: manifest.serverDependencies ?? {},
    resolutions: manifest.resolutions ?? {},
    aliases: manifest.aliases ?? {},
  }
}

/**
 * A default package name for `rarn init`, derived from the directory name.
 *
 * Wally names are lowercase with dashes, so anything else is folded rather than
 * rejected — failing `init` because a folder has a capital letter would be hostile.
 */
export function suggestPackageName(dir: string): string {
  const folded = basename(resolve(dir))
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return folded === '' ? 'my-game' : folded
}
