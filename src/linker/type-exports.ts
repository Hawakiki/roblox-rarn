import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchBracket, stripCommentsAndStrings } from '../util/luau.ts'

/**
 * Finds the type aliases a package's entry module exports.
 *
 * A link shim forwards a module's *value* and, without help, none of its types:
 * `require(Packages.React)` binds to the shim, and the shim exports nothing. So
 * `React.createElement` type-checks and `React.Node` is `Unknown type 'React.Node'`,
 * at every call site, which makes `--!strict` signatures impossible to write against
 * any typed package. Wally has the same hole.
 *
 * The fix is one line per type in the shim — `export type Node = M.Node` — which
 * means knowing the names, which means reading the entry file. This is that reading,
 * and it is deliberately shallow: enough to recognise a declaration header, and
 * nothing that could be called parsing Luau.
 *
 * **Silence is the failure mode.** Anything not understood is left out rather than
 * guessed at, because a wrong re-export puts an error in a generated file the user
 * did not write and cannot fix. A missing one costs them the annotation they were
 * going to write by hand anyway.
 */

export interface TypeExport {
  readonly name: string
  /** Parameters as declared, defaults included: `Props, State = nil`. */
  readonly declared: string
  /** The same parameters applied on the right: `Props, State`. */
  readonly applied: string
}

/** Types Luau resolves without anything being in scope. */
const BUILTIN = new Set([
  'any',
  'boolean',
  'buffer',
  'never',
  'nil',
  'number',
  'string',
  'thread',
  'unknown',
  'vector',
])

/**
 * The entry module of a package, which is the only file whose exports a shim forwards.
 *
 * A type declared in a submodule reaches the outside only if the entry re-exports it,
 * and then it is here under the entry's own name — which is the name a user writes.
 *
 * `isFile` comes from pruning, which already knows whether the module became a
 * directory or a single file. Probing for it here instead cost two `stat` calls per
 * package, and on Windows that was most of a 225ms regression on a 52-package
 * install — for a question something upstream had already answered.
 */
export async function readTypeExports(
  moduleRoot: string,
  isFile: boolean,
): Promise<readonly TypeExport[]> {
  const candidates = isFile
    ? [moduleRoot]
    : [join(moduleRoot, 'init.luau'), join(moduleRoot, 'init.lua')]

  for (const candidate of candidates) {
    // A miss is the ordinary case for the first candidate, so it is read for and not
    // asked about: one failed open beats a stat plus an open.
    const source = await readFile(candidate, 'utf8').catch(() => null)
    if (source !== null) return parseTypeExports(source)
  }
  return []
}

export function parseTypeExports(source: string): readonly TypeExport[] {
  const code = stripCommentsAndStrings(source)
  const found: TypeExport[] = []
  const names = new Set<string>()

  // `export` is not a keyword outside this position, but a variable may be called
  // `exports`, so the boundary is checked rather than assumed.
  const header = /(^|[^\w.])export\s+type\s+([A-Za-z_]\w*)/g

  let match = header.exec(code)
  while (match !== null) {
    const name = match[2]
    const after = match.index + match[0].length
    match = header.exec(code)

    if (name === undefined || names.has(name)) continue

    // `export type function` is a type function, not an alias: there is nothing to
    // forward and the name is the keyword.
    if (name === 'function') continue

    const parameters = parametersAt(code, after)
    if (parameters === undefined) continue

    names.add(name)
    found.push({ name, ...parameters })
  }

  // Only what every re-export can actually name. A default referring to a type the
  // module keeps to itself would compile in the package and not in the shim, so the
  // whole declaration is dropped rather than emitted broken.
  //
  // Repeated to a fixed point, because dropping one can strand another: a default
  // naming a type that was itself dropped is no better off than one naming a type
  // that was never exported. Each pass can only remove, so this terminates.
  let surviving = names
  for (;;) {
    const kept = found.filter((type) => surviving.has(type.name) && resolvable(type, surviving))
    if (kept.length === surviving.size) return kept
    surviving = new Set(kept.map((type) => type.name))
  }
}

/**
 * Reads the generic parameter list starting at `at`, if there is one.
 *
 * Returns `undefined` only when a list is opened and never closed, which is a file
 * this has no business interpreting.
 */
function parametersAt(code: string, at: number): { declared: string; applied: string } | undefined {
  let i = at
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1
  if (code[i] !== '<') return { declared: '', applied: '' }

  const close = matchBracket(code, i, '<', '>')
  if (close === -1) return undefined

  const declared = code.slice(i + 1, close).trim()
  const applied = splitTop(declared)
    .map((parameter) => parameter.split('=')[0]?.trim() ?? '')
    .filter((parameter) => parameter !== '')
    .join(', ')

  return { declared, applied }
}

/**
 * Splits a parameter list on the commas that separate parameters.
 *
 * `Props, State = { [string]: Foo<T, U> }` is two parameters, and every naive split
 * makes it four.
 */
function splitTop(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < list.length; i++) {
    const character = list[i]
    if (character === '<' || character === '{' || character === '(' || character === '[') depth += 1
    else if (character === '>' || character === '}' || character === ')' || character === ']') {
      depth -= 1
    } else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }

  parts.push(list.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Whether every name a declaration's defaults reach for will exist in the shim.
 *
 * `export type ReactElement<Props = Object, ElementType = any>` is fine, because
 * `Object` is exported alongside it and the shim re-exports that too. The same
 * declaration defaulting to an internal type is not, and there is no way to tell from
 * the name alone — so what the module exports is the whole allowance.
 */
function resolvable(type: TypeExport, exported: ReadonlySet<string>): boolean {
  const parameters = splitTop(type.declared)

  // A default may name an earlier parameter of the same declaration, which is in
  // scope there and nowhere else.
  const own = new Set(
    parameters.map((parameter) => (parameter.split('=')[0] ?? '').trim().replaceAll('...', '')),
  )

  return parameters.every((parameter) => {
    const [, ...rest] = parameter.split('=')
    if (rest.length === 0) return true

    // Identifiers only; `{`, `|`, `->` and the rest are structure, and a type built
    // entirely from names that resolve is itself resolvable.
    const referenced = rest.join('=').match(/[A-Za-z_]\w*/g) ?? []
    return referenced.every((name) => BUILTIN.has(name) || exported.has(name) || own.has(name))
  })
}
