import addFormats from 'ajv-formats'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import semver from 'semver'
import schema from '../../schemas/rarn.schema.json' with { type: 'json' }
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { deriveAlias, parsePackageName, toRarnName } from '../util/package-name.ts'
import { normalizeRange } from '../util/version-range.ts'
import { DEPENDENCY_SECTIONS, type Manifest } from './types.ts'

/**
 * Validation happens in two passes, because a JSON Schema cannot express every rule
 * that matters here.
 *
 * 1. **Shape** — ajv against `rarn.schema.json`. Types, required fields, key patterns.
 * 2. **Semantics** — this file. Whether `^^4` is a real semver range, whether two
 *    packages derive the same shim filename, whether a `resolutions` entry is an
 *    exact version rather than a range.
 *
 * The split matters for error quality: a schema can only say "does not match pattern",
 * while the second pass can say which two packages collided and what to do about it.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
addFormats(ajv)
const validateShape = ajv.compile<Manifest>(schema)

/** Reads a manifest that has already been parsed from JSON, or throws. */
export function validateManifest(data: unknown, where: string): Manifest {
  preValidateVersions(data, where)

  if (!validateShape(data)) {
    throw new RarnError({
      code: Code.ManifestInvalid,
      what: `${where} does not match the Rarn manifest schema.`,
      where,
      detail: formatSchemaErrors(validateShape.errors ?? []),
      how: 'Fix the fields listed above. The full schema is in schemas/rarn.schema.json.',
    })
  }

  validateSemantics(data, where)
  return data
}

/**
 * Checks version-shaped fields before ajv gets to them.
 *
 * The schema carries semver patterns too, which is worth keeping: an editor with
 * JSON Schema support squiggles a bad version as it is typed. But a regex can only
 * report "has the wrong form", and for `resolutions` that is the least useful half
 * of the answer — the user needs to know that a *range* is refused there on purpose,
 * because an override that still had to be resolved would not override anything.
 *
 * So the schema keeps the pattern for editors, and the better message wins at the
 * command line. Only string values are inspected; anything else is left for ajv,
 * which is the right place to report a wrong type.
 */
function preValidateVersions(data: unknown, where: string): void {
  if (typeof data !== 'object' || data === null) return
  const record = data as Record<string, unknown>

  if (typeof record.version === 'string') {
    assertVersion(record.version, 'version', where)
  }

  const resolutions = record.resolutions
  if (typeof resolutions === 'object' && resolutions !== null) {
    for (const [name, value] of Object.entries(resolutions as Record<string, unknown>)) {
      if (typeof value === 'string') assertExactResolution(name, value, where)
    }
  }
}

/**
 * Renders ajv errors as lines a person can act on.
 *
 * ajv reports locations as JSON Pointers (`/dependencies/@evaera~1promise`), which
 * are precise but unreadable — and the escaping makes a package name look corrupted.
 * Turning them back into `dependencies["@evaera/promise"]` is most of the work.
 */
function formatSchemaErrors(errors: readonly ErrorObject[]): string {
  // Where `propertyNames` rejected a key, ajv also emits the inner pattern failure
  // *at the same path*. The outer error knows which key was rejected and the inner
  // one carries no data, so the inner one is the duplicate — but only there.
  const byPropertyNames = new Set(
    errors.filter((error) => error.keyword === 'propertyNames').map((error) => error.instancePath),
  )

  const seen = new Set<string>()
  const lines: string[] = []

  for (const error of errors) {
    // A failing `$ref`/`anyOf` branch also reports its parent, which would double
    // every message; the specific child error is the useful one.
    if (error.keyword === 'if' || error.keyword === 'anyOf') continue
    if (error.keyword === 'pattern' && byPropertyNames.has(error.instancePath)) continue

    const location = pointerToPath(error.instancePath)
    const line = `  ${location || '(root)'}: ${describe(error)}`
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }

  // The filters above once removed every error there was, and the message became
  // "does not match the schema" followed by nothing, under a `how` that said to fix
  // the fields listed above. A noisy list beats an empty one: whatever survives the
  // filter is a guess about which error is most useful, and a guess that leaves the
  // reader with no information at all is the one failure mode worth ruling out.
  if (lines.length === 0 && errors.length > 0) {
    return errors
      .map((error) => `  ${pointerToPath(error.instancePath) || '(root)'}: ${describe(error)}`)
      .join('\n')
  }

  return lines.join('\n')
}

function describe(error: ErrorObject): string {
  switch (error.keyword) {
    case 'required':
      return `missing required field '${String(error.params.missingProperty)}'`
    case 'additionalProperties':
      return `unknown field '${String(error.params.additionalProperty)}'`
    case 'enum': {
      // ajv types `params` as Record<string, any>, so the value is narrowed here
      // rather than trusted — a malformed schema should not crash the error printer.
      const allowed: unknown = error.params.allowedValues
      if (!Array.isArray(allowed)) return 'is not one of the allowed values'
      return `must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`
    }
    case 'pattern':
      return `'${String(error.data)}' has the wrong form`
    case 'propertyNames': {
      const key: unknown = error.params.propertyName
      const named = typeof key === 'string' ? `key '${key}'` : 'a key'
      return `${named} has the wrong form (expected "@scope/name")`
    }
    case 'type':
      return `must be ${String(error.params.type)}`
    default:
      return error.message ?? 'is invalid'
  }
}

/** `/dependencies/@evaera~1promise` -> `dependencies["@evaera/promise"]` */
function pointerToPath(pointer: string): string {
  if (pointer === '') return ''
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((path, token) => {
      if (path === '') return token
      // Anything that is not a plain identifier reads better bracketed and quoted.
      return /^[A-Za-z_$][\w$]*$/.test(token) ? `${path}.${token}` : `${path}["${token}"]`
    }, '')
}

/** The rules that need real semver and cross-field knowledge. */
function validateSemantics(manifest: Manifest, where: string): void {
  assertVersion(manifest.version, 'version', where)

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section]
    if (deps === undefined) continue
    for (const [name, range] of Object.entries(deps)) {
      assertRange(range, `${section}["${name}"]`, where)
    }
  }

  for (const [name, version] of Object.entries(manifest.resolutions ?? {})) {
    assertExactResolution(name, version, where)
  }

  assertNoAliasCollisions(manifest, where)
}

function assertExactResolution(name: string, version: string, where: string): void {
  if (semver.valid(version) !== null) return
  throw new RarnError({
    code: Code.InvalidVersion,
    what: `resolutions["${name}"] must be an exact version, but is '${version}'.`,
    where,
    how: 'Use a single version such as "4.0.0". A range is refused here on purpose: an override that still had to be resolved would not override anything.',
  })
}

function assertVersion(version: string, field: string, where: string): void {
  if (semver.valid(version) !== null) return
  throw new RarnError({
    code: Code.InvalidVersion,
    what: `${field} must be an exact semver version, but is '${version}'.`,
    where,
    how: "Use a version such as '1.0.0'.",
  })
}

function assertRange(range: string, field: string, where: string): void {
  try {
    normalizeRange(range)
  } catch {
    throw new RarnError({
      code: Code.InvalidVersionRange,
      what: `${field} is '${range}', which is not a valid version range.`,
      where,
      how: "Use a range such as '^4.0.0', '~1.2.3', '>=1.0.0 <2.0.0', or '*'.",
    })
  }
}

/**
 * Two packages whose names PascalCase to the same alias would generate one shim file
 * and one of them would silently disappear. Caught here rather than at link time so
 * the message can point at the manifest the user can actually edit.
 */
function assertNoAliasCollisions(manifest: Manifest, where: string): void {
  const byAlias = new Map<string, string[]>()

  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const override = manifest.aliases?.[name]
      const alias = override ?? deriveAlias(parsePackageName(name))
      const existing = byAlias.get(alias)
      if (existing === undefined) byAlias.set(alias, [name])
      else existing.push(name)
    }
  }

  for (const [alias, names] of byAlias) {
    if (names.length < 2) continue
    throw new RarnError({
      code: Code.AliasCollision,
      what: `${names.length} packages would both be installed as '${alias}'.`,
      where,
      detail: names.map((name) => `  ${name}`).join('\n'),
      how: `Give one of them a different name under "aliases", for example:\n  "aliases": { ${JSON.stringify(names[0] ?? '')}: "${alias}2" }`,
    })
  }
}

/** Every dependency declared anywhere, as `@scope/name` -> range. */
export function allDependencies(manifest: Manifest): Map<string, string> {
  const all = new Map<string, string>()
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      all.set(toRarnName(parsePackageName(name)), range)
    }
  }
  return all
}
