import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { readManifestRaw } from '../../manifest/read.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { withoutDependency, writeManifest } from '../../manifest/write.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toRarnName } from '../../util/package-name.ts'
import { install } from './install.ts'

export interface RemoveOptions {
  cwd: string
  specs: readonly string[]
}

/**
 * Removes packages from the manifest and reinstalls.
 *
 * Reinstalling is what actually deletes the files: the linker wipes and rebuilds the
 * realm directories, so anything no longer resolved simply does not come back. There
 * is no separate orphan-collection step to get wrong.
 */
export async function remove(
  options: RemoveOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  let manifest = await readManifestRaw(projectDir)

  const removed: string[] = []
  const missing: string[] = []

  for (const spec of options.specs) {
    const name = toRarnName(parsePackageName(stripVersion(spec)))
    const result = withoutDependency(manifest, name)

    if (result.removedFrom.length === 0) {
      missing.push(name)
      continue
    }
    manifest = result.manifest
    removed.push(name)
  }

  // Reported rather than ignored. Removing something that was never there usually
  // means a typo, and silently succeeding would leave the user believing the
  // dependency is gone when it is still installed under a different name.
  if (missing.length > 0) {
    throw new RarnError({
      code: Code.InvalidArguments,
      what:
        missing.length === 1
          ? `${missing[0] ?? ''} is not a dependency of this project.`
          : `${missing.length} of those are not dependencies of this project.`,
      where: 'rarn.json',
      detail: missing.map((name) => `  ${name}`).join('\n'),
      how: 'Run `rarn list` to see what is installed. Nothing was removed.',
    })
  }

  validateManifest(manifest, 'rarn.json')
  await writeManifest(projectDir, manifest)

  for (const name of removed) {
    process.stdout.write(`${chalk.green('removed')} ${name}\n`)
  }

  await install({ cwd: projectDir }, registry)
}

/** `@scope/name@1.0.0` -> `@scope/name`. A version here is accepted and ignored. */
function stripVersion(spec: string): string {
  const slash = spec.indexOf('/')
  const at = spec.lastIndexOf('@')
  return slash !== -1 && at > slash ? spec.slice(0, at) : spec
}
