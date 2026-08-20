import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import addFormats from 'ajv-formats'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../schemas/rarn.lock.schema.json' with { type: 'json' }

import type { Constraint, Placement, Resolution, ResolvedPackage } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { isNotFoundError } from '../util/fs.ts'
import { parsePackageName } from '../util/package-name.ts'
import { LOCKFILE_NAME, LOCKFILE_VERSION, type Lockfile } from './types.ts'

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
addFormats(ajv)
const validate = ajv.compile<Lockfile>(schema)

/** Reads `rarn.lock`, or undefined when there is none. */
export async function readLockfile(dir: string): Promise<Lockfile | undefined> {
  const path = join(resolve(dir), LOCKFILE_NAME)

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw new RarnError({
      code: Code.LockfileInvalid,
      what: `Could not read ${LOCKFILE_NAME}.`,
      where: path,
      how: 'Check the file permissions, or delete it and reinstall.',
      cause: error,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new RarnError({
      code: Code.LockfileInvalid,
      what: `${LOCKFILE_NAME} is not valid JSON.`,
      where: path,
      how: 'It is generated, so the safe fix is to delete it and run install again.',
      cause,
    })
  }

  // Checked before the schema, because a newer lockfile will fail schema validation
  // for reasons that have nothing to do with being malformed, and "your Rarn is too
  // old" is a far more useful thing to be told.
  const version = (parsed as { lockfileVersion?: unknown }).lockfileVersion
  if (typeof version === 'number' && version > LOCKFILE_VERSION) {
    throw new RarnError({
      code: Code.LockfileTooNew,
      what: `${LOCKFILE_NAME} was written by a newer version of Rarn (lockfileVersion ${version}).`,
      where: path,
      how: `This Rarn understands version ${LOCKFILE_VERSION}. Upgrade Rarn rather than deleting the lockfile — regenerating it here could silently change the versions everyone else is using.`,
    })
  }

  if (!validate(parsed)) {
    throw new RarnError({
      code: Code.LockfileInvalid,
      what: `${LOCKFILE_NAME} does not match the lockfile schema.`,
      where: path,
      detail: (validate.errors ?? [])
        .slice(0, 8)
        .map((e) => `  ${e.instancePath || '(root)'}: ${e.message ?? 'is invalid'}`)
        .join('\n'),
      how: 'It is generated, so the safe fix is to delete it and run install again.',
    })
  }

  return parsed
}

/**
 * Rebuilds a `Resolution` from a lockfile, with no registry access at all.
 *
 * This is what the lockfile is *for*. Resolution is the only stage that needs the
 * network — fetching comes from the cache and linking is local — so reconstructing it
 * from the file is what turns a warm install into an offline one.
 *
 * The reconstruction has to be lossless. If it is not, a cold install and a warm one
 * produce different trees, which is the worst possible outcome: both succeed and
 * only one is right. `tests/lockfile.test.ts` pins that with a round trip.
 */
export function resolutionFromLockfile(lockfile: Lockfile): Resolution {
  const packages = new Map<string, ResolvedPackage>()
  const byName = new Map<string, string[]>()

  for (const key of Object.keys(lockfile.packages).sort()) {
    const locked = lockfile.packages[key]
    if (locked === undefined) continue

    const name = parsePackageName(key.slice(0, key.lastIndexOf('@')))
    const placement: Placement = locked.placement ?? (locked.dev === true ? 'dev' : 'shared')

    const requestedBy: Constraint[] = (locked.requestedBy ?? []).map((entry) => ({
      from: entry.from,
      range: entry.range,
      placement,
    }))

    packages.set(key, {
      name,
      version: locked.version,
      realm: locked.realm,
      placement,
      dependencies: new Map(Object.entries(locked.dependencies ?? {})),
      requestedBy,
      dev: locked.dev ?? false,
      forcedBy:
        lockfile.root.resolutions?.[`@${name.scope}/${name.name}`] === undefined
          ? undefined
          : 'resolutions',
    })

    const list = byName.get(`@${name.scope}/${name.name}`)
    if (list === undefined) byName.set(`@${name.scope}/${name.name}`, [locked.version])
    else list.push(locked.version)
  }

  const duplicates = new Map<string, string[]>()
  for (const [name, versions] of byName) {
    if (versions.length > 1) duplicates.set(name, versions)
  }

  return {
    packages,
    duplicates,
    overrides: new Map(Object.entries(lockfile.root.resolutions ?? {})),
  }
}
