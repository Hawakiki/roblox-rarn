/**
 * Runs `body` the way a machine whose default locale is `locale` would.
 *
 * `localeCompare` with no locale argument collates by the process default, which Bun
 * takes from the operating system — on Windows it ignores `LANG` entirely — so no
 * environment variable can move a test onto another machine. Supplying the default
 * where the runtime would is the same move, made from inside the process.
 */
export async function asIfLocale<T>(locale: string, body: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')
  Object.defineProperty(String.prototype, 'localeCompare', {
    ...original,
    value(
      this: string,
      that: string,
      locales?: Intl.LocalesArgument,
      options?: Intl.CollatorOptions,
    ): number {
      return new Intl.Collator(locales ?? locale, options).compare(this, that)
    },
  })
  try {
    return await body()
  } finally {
    if (original !== undefined) Object.defineProperty(String.prototype, 'localeCompare', original)
  }
}
