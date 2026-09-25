import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { byCodeUnit } from '../src/util/order.ts'
import { asIfLocale } from './locale.ts'

describe('byCodeUnit', () => {
  // The lockfile's `packages` map and the manifest were already written with a bare
  // `.sort()`. Agreeing with it exactly is what makes the whole file one rule.
  test('agrees with sort() given no comparator', () => {
    const words = ['t', 'TestEZ', 'Llama', 'es7_types', 'es7-types', '@a/dog', '@a/chalk', 'root']
    expect([...words].sort(byCodeUnit)).toEqual([...words].sort())
  })

  test('is not moved by the machine locale', async () => {
    expect(await asIfLocale('cs', () => ['@a/dog', '@a/chalk'].sort(byCodeUnit))).toEqual([
      '@a/chalk',
      '@a/dog',
    ])
  })
})

describe('asIfLocale', () => {
  // Every locale test in the suite leans on this. A stand-in that moved nothing would
  // let each of them pass against the very code it was written to catch.
  test('really moves the default collation', async () => {
    expect(await asIfLocale('en', () => 'chalk'.localeCompare('dog'))).toBeLessThan(0)
    expect(await asIfLocale('cs', () => 'chalk'.localeCompare('dog'))).toBeGreaterThan(0)
  })

  test('puts the original back, even when the body throws', async () => {
    const before = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')
    await asIfLocale('cs', () => {
      throw new Error('boom')
    }).catch(() => undefined)
    expect(Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')).toEqual(before)
  })
})

describe('src', () => {
  // Collating by locale is the idiomatic way to sort strings in JavaScript, so it is the
  // one every new sort reaches for. Each of the sites it replaced was written, reads and
  // was reviewed as correct, and only a second machine could say otherwise.
  test('nothing collates by the machine locale', async () => {
    const root = join(import.meta.dir, '..', 'src')
    const offenders: string[] = []

    for (const file of await readdir(root, { recursive: true })) {
      if (!file.endsWith('.ts')) continue
      const lines = (await readFile(join(root, file), 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (line.includes('.localeCompare(')) {
          offenders.push(`src/${file.replaceAll('\\', '/')}:${i + 1}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })
})
