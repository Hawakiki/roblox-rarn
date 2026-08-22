/**
 * Reading Luau as text, for the two places that have to.
 *
 * Neither one parses Luau properly and neither should: `doctor` wants the requires a
 * package makes, and the linker wants the type aliases a module exports. Both are
 * shapes near the top of a file, and both become wrong the moment a doc comment is
 * read as code — which is the whole reason this lives here rather than in either.
 */

/**
 * Removes comments and string bodies, keeping line numbers intact.
 *
 * Not cosmetic. Luau packages document themselves with `--[=[ ]=]` blocks full of
 * example code, and a naive scan reads every one of those examples as real code — in
 * a survey of thirteen registry packages, most of what first looked like dynamic
 * requires turned out to be doc comments.
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

/**
 * The index of the bracket closing the one at `open`, or -1.
 *
 * Generic parameter lists nest — `<T, U = Map<string, T>>` — so finding the end means
 * counting rather than searching for the next `>`.
 */
export function matchBracket(text: string, open: number, opener: string, closer: string): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth += 1
    else if (text[i] === closer) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}
