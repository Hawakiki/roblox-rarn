/**
 * Finds the dependency requires in a package's Luau source.
 *
 * A package reaches its dependencies by walking up to its own `_Index` entry folder,
 * where Rarn puts the shims: from a file `d` levels inside the module, that is
 * `script` followed by `d + 1` uses of `.Parent`, then the alias. Anything shallower
 * or deeper is the package addressing its own internals and is none of our business.
 *
 * The point of finding them is that a require naming an alias with no shim behind it
 * resolves to `nil` at runtime, and nothing about the install looks wrong until then.
 */

export interface RequireFinding {
  /** Alias the source expects to find beside its module folder. */
  readonly alias: string
  readonly line: number
}

export interface ScanResult {
  readonly dependencies: readonly RequireFinding[]
  /**
   * Requires whose target could not be worked out statically.
   *
   * Reported rather than ignored: they are the blind spot, and a check that hides
   * how much it could not see reads as more thorough than it is.
   */
  readonly dynamic: readonly { readonly expression: string; readonly line: number }[]
}

/**
 * `depth` is how far the file's script sits inside the module root:
 * `init.lua` is 0, a sibling file is 1, a file one folder down is 2.
 */
export function scanSource(source: string, depth: number): ScanResult {
  const code = stripCommentsAndStrings(source)
  const aliases = trackScriptAliases(code)
  const wantedParents = depth + 1

  const dependencies: RequireFinding[] = []
  const dynamic: { expression: string; line: number }[] = []

  for (const call of findRequires(code)) {
    const resolved = resolveExpression(call.expression, aliases)

    if (resolved === undefined) {
      dynamic.push({ expression: call.expression.trim(), line: call.line })
      continue
    }
    // Internal navigation, not a dependency. Silently fine.
    if (resolved.parents !== wantedParents) continue

    dependencies.push({ alias: resolved.tail, line: call.line })
  }

  return { dependencies, dynamic }
}

/**
 * Removes comments and string bodies, keeping line numbers intact.
 *
 * Not cosmetic. Luau packages document themselves with `--[=[ ]=]` blocks full of
 * example code, and a naive scan reads every one of those examples as a real
 * require — in a survey of thirteen registry packages, most of what first looked
 * like dynamic requires turned out to be doc comments.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0

  const keepNewlines = (text: string): string => text.replaceAll(/[^\n]/g, ' ')

  while (i < source.length) {
    const rest = source.slice(i)

    const comment = /^--(\[=*\[)?/.exec(rest)
    if (comment !== null) {
      if (comment[1] !== undefined) {
        const close = `]${'='.repeat(comment[1].length - 2)}]`
        const end = source.indexOf(close, i + comment[0].length)
        const stop = end === -1 ? source.length : end + close.length
        out += keepNewlines(source.slice(i, stop))
        i = stop
        continue
      }
      const eol = source.indexOf('\n', i)
      const stop = eol === -1 ? source.length : eol
      out += keepNewlines(source.slice(i, stop))
      i = stop
      continue
    }

    const longString = /^\[=*\[/.exec(rest)
    if (longString !== null) {
      const close = `]${'='.repeat(longString[0].length - 2)}]`
      const end = source.indexOf(close, i + longString[0].length)
      const stop = end === -1 ? source.length : end + close.length
      out += keepNewlines(source.slice(i, stop))
      i = stop
      continue
    }

    const quote = source[i]
    if (quote === '"' || quote === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') j += 1
        if (source[j] === '\n') break
        j += 1
      }
      const stop = Math.min(j + 1, source.length)
      const literal = source.slice(i, stop)

      // A plain name survives; anything else is blanked. Both halves matter:
      // `folder["Promise"]` is bracket indexing and the name is the whole point,
      // while a string long enough to hold `require(...)` is the case worth hiding.
      //
      // A dot is part of a name here, not a separator. Rojo derives an instance name
      // by removing one extension, so `ReactFiberWorkLoop.new.lua` becomes an instance
      // called `ReactFiberWorkLoop.new` — react-lua has dozens, and blanking them
      // turned every `:WaitForChild("ReactFiberWorkLoop.new")` into an unreadable
      // require.
      out += /^(['"])[A-Za-z_][\w.-]*\1$/.test(literal) ? literal : keepNewlines(literal)
      i = stop
      continue
    }

    out += source[i] ?? ''
    i += 1
  }

  return out
}

interface RequireCall {
  readonly expression: string
  readonly line: number
}

function findRequires(code: string): RequireCall[] {
  const calls: RequireCall[] = []
  const pattern = /\brequire\s*\(/g

  let match = pattern.exec(code)
  while (match !== null) {
    const open = match.index + match[0].length - 1
    const close = matchParen(code, open)
    if (close !== -1) {
      calls.push({
        expression: code.slice(open + 1, close),
        line: countLines(code, match.index),
      })
    }
    match = pattern.exec(code)
  }

  return calls
}

function matchParen(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth += 1
    else if (code[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function countLines(code: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (code[i] === '\n') line += 1
  return line
}

/**
 * Records names that were assigned a `script.Parent…` chain.
 *
 * Worth the effort because the most used framework in the ecosystem does exactly
 * this. `sleitnick/knit` writes `KnitClient.Util = (script.Parent :: Instance).Parent`
 * and then requires through that field, so a scanner that only matched literal
 * `script.Parent.Parent.X` would see its dependencies as unresolvable and report the
 * package as entirely dynamic.
 */
function trackScriptAliases(code: string): Map<string, number> {
  const aliases = new Map<string, number>()
  const pattern = /(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*([^\n;]+)/g

  let match = pattern.exec(code)
  while (match !== null) {
    const [, name, value] = match
    if (name !== undefined && value !== undefined) {
      const chain = countScriptParents(value)
      if (chain !== undefined) aliases.set(name, chain)
    }
    match = pattern.exec(code)
  }

  return aliases
}

/** `(script.Parent :: Instance).Parent` -> 2, and `nil` when it is not a script chain. */
function countScriptParents(expression: string): number | undefined {
  const flat = normalize(expression)
  const match = /^script((?:\.Parent)*)\s*$/.exec(flat)
  if (match?.[1] === undefined) return undefined
  return match[1].split('.Parent').length - 1
}

/**
 * Flattens the decorations Luau allows around a script chain.
 *
 * Type casts and the parentheses they force are the common case:
 * `(script.Parent :: Instance).Parent` is the same expression as
 * `script.Parent.Parent`, and only the second form is recognisable by shape.
 */
function normalize(expression: string): string {
  let flat = expression.replaceAll(/::\s*[\w.<>{}|?\s]+/g, '')
  flat = flat.replaceAll(/\(\s*(script[^()]*?)\s*\)/g, '$1')
  return flat.replaceAll(/\s+/g, '')
}

interface Resolved {
  readonly parents: number
  readonly tail: string
}

/**
 * One lookup step, in every spelling Roblox accepts for the same operation.
 *
 * `:WaitForChild("x")` is the one that matters. It reads as a method call rather than
 * an index, so a scanner built around `.Foo` and `["Foo"]` sees nothing — and the
 * entire jsdotlua family (react-lua, jest-lua, luau-polyfill: the JS-port half of the
 * registry) writes every single require that way. Measured on a 52-package install,
 * 1655 of 1663 unreadable requires were this one form.
 *
 * The trailing `[^()]*` is `WaitForChild`'s optional timeout argument.
 */
const STEP =
  /^(?:\.([A-Za-z_]\w*)|\[(['"])([^'"\]]+)\2\]|:(?:WaitForChild|FindFirstChild)\((['"])([^'"()]+)\4[^()]*\))/

/** The name reached by the first lookup step in `rest`, if it starts with one. */
function firstStep(rest: string): string | undefined {
  const match = STEP.exec(rest)
  if (match === null) return undefined
  return match[1] ?? match[3] ?? match[5]
}

/**
 * Works out how far up an expression reaches, and what it asks for there.
 *
 * Only the *first* step past the parent chain is the answer; anything after it is
 * inside whatever that step reached and is none of our business. Requiring the whole
 * expression to be one step — which this did — dropped `script.Parent.Parent.Foo.Bar`
 * into the unreadable pile, where most of those are the package walking its own
 * internals and should have been passed over in silence instead.
 */
function resolveExpression(
  expression: string,
  aliases: ReadonlyMap<string, number>,
): Resolved | undefined {
  const flat = normalize(expression)

  // `\b` so that a variable named `scriptConfig` is not read as a chain from `script`.
  const fromScript = /^script\b((?:\.Parent)*)/.exec(flat)
  if (fromScript !== null) {
    const tail = firstStep(flat.slice(fromScript[0].length))
    if (tail === undefined) return undefined
    return { parents: (fromScript[1] ?? '').split('.Parent').length - 1, tail }
  }

  // Through a name that was assigned a chain earlier in the same file. Tracked names
  // may themselves contain dots (`KnitClient.Util`), so the longest prefix that was
  // actually recorded wins and the rest of the expression is the lookup.
  const base = /^[A-Za-z_][\w.]*/.exec(flat)
  if (base === null) return undefined

  for (let name = base[0]; name !== ''; ) {
    const parents = aliases.get(name)
    if (parents !== undefined) {
      const tail = firstStep(flat.slice(name.length))
      return tail === undefined ? undefined : { parents, tail }
    }

    const cut = name.lastIndexOf('.')
    if (cut === -1) break
    name = name.slice(0, cut)
  }

  return undefined
}
