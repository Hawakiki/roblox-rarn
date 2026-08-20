import semver from 'semver'
import type { PackageMetadata, PackageVersion } from '../registry/types.ts'
import { toWallyName } from '../util/package-name.ts'
import type { Constraint } from './types.ts'

const OPTS = { includePrerelease: true } as const

/**
 * Renders why a set of requirements could not be met.
 *
 * The point of these is that Wally's equivalent does not say enough. When it gives up
 * it names the package and lists the versions it rejected, which leaves the user with
 * no idea *who* wanted what. Knowing which dependency asked for the blocking range is
 * usually the whole answer, since the fix is almost always "upgrade that one".
 */

/** Requirements that no published version satisfies. */
export function describeUnsatisfiable(
  name: string,
  metadata: PackageMetadata,
  unsatisfiable: readonly Constraint[],
): string {
  const lines = unsatisfiable.map((c) => `  ${c.range.padEnd(20)} <- ${requesterLabel(c.from)}`)

  const published = metadata.versions.map((v) => v.version)
  const preview = published.slice(0, 6).join(', ')
  const more = published.length > 6 ? `, ... (${published.length} total)` : ''

  return [
    `Requirements that cannot be met for ${name}:`,
    ...lines,
    '',
    `  published: ${preview}${more}`,
  ].join('\n')
}

/**
 * Two versions of one package that share a major.
 *
 * Not the same thing as two different majors coexisting, which is fine. This is the
 * case that silently breaks singletons, so the message says so rather than only
 * reporting the version numbers.
 */
export function describeConflict(
  name: string,
  versions: readonly string[],
  constraints: readonly Constraint[],
): string {
  const lines: string[] = [`${name} would be installed at ${versions.length} versions:`]

  for (const version of versions) {
    lines.push(`  ${version}`)
    // Only the requesters that version actually serves. Listing all of them under
    // each version would make it look as though every requester wanted every copy,
    // which is the opposite of what the reader needs to see.
    const wanted = constraints.filter((c) => semver.satisfies(version, c.range, OPTS))
    for (const c of wanted.length > 0 ? wanted : constraints) {
      lines.push(`    ${c.range.padEnd(20)} <- ${requesterLabel(c.from)}`)
    }
  }

  lines.push(
    '',
    '  Two copies become two ModuleScript instances at runtime, each with its own',
    '  state, so any singleton inside the package stops being one.',
  )
  return lines.join('\n')
}

/** A shared package reaching for a server-only one. */
export function describeRealmViolation(entry: PackageVersion, offender: Constraint): string {
  return [
    `  ${requesterLabel(offender.from)}`,
    `    is placed in '${offender.placement}'`,
    `    and requires ${toWallyName(entry.name)}@${entry.version}, declared '${entry.realm}'`,
  ].join('\n')
}

/** `'root'` reads better as the file the user can actually edit. */
function requesterLabel(from: string): string {
  return from === 'root' ? 'rarn.json (direct dependency)' : from
}
