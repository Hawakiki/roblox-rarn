import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { unzip } from 'fflate'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'

/** `PK\x03\x04` — the local file header every ZIP starts with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/**
 * Whether these bytes are a ZIP.
 *
 * Checked rather than trusting the response, because the registry lies about it:
 * `package-contents` answers `Content-Type: application/gzip` while the body is a
 * ZIP. Verified live. Believing the header would send the bytes to a gzip decoder
 * that fails with a confusing error about a corrupt stream.
 */
export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, i) => bytes[i] === byte)
}

export interface ExtractResult {
  /** Files written, relative to the destination, with `/` separators. */
  readonly files: readonly string[]
}

/**
 * Unpacks a ZIP into `destination`, which must already exist and be empty.
 *
 * Rejects the archive outright rather than skipping a bad entry: a package that
 * contains a traversal path is not a package with one broken file, it is an archive
 * that should not be trusted at all.
 */
export async function extractZip(
  bytes: Uint8Array,
  destination: string,
  subject: string,
): Promise<ExtractResult> {
  if (!isZip(bytes)) {
    throw new RarnError({
      code: Code.ArchiveUnreadable,
      what: `The archive for ${subject} is not a ZIP file.`,
      where: subject,
      detail: `  first bytes: ${[...bytes.slice(0, 4)].map(hex).join(' ')}`,
      how: 'The registry returned something unexpected. Try again; if it persists, report it.',
    })
  }

  const entries = await inflate(bytes, subject)
  const files: string[] = []

  for (const [rawName, content] of Object.entries(entries)) {
    // Directory entries carry no content and are recreated implicitly by mkdir.
    if (rawName.endsWith('/')) continue

    const relative = safeEntryPath(rawName, subject)
    const target = join(destination, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    files.push(relative)
  }

  return { files: files.sort() }
}

function inflate(bytes: Uint8Array, subject: string): Promise<Record<string, Uint8Array>> {
  // fflate's async form hands the work to a worker, so a large package does not
  // stall every other download running in parallel.
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => {
      if (error) {
        reject(
          new RarnError({
            code: Code.ArchiveUnreadable,
            what: `The archive for ${subject} could not be unpacked.`,
            where: subject,
            detail: `  ${error.message}`,
            how: 'The download may be corrupt. Try again.',
            cause: error,
          }),
        )
        return
      }
      resolve(data)
    })
  })
}

/**
 * Validates one entry name and returns it in platform form.
 *
 * Two separate hazards:
 *
 * - **Zip slip.** An entry named `../../etc/thing` or `/etc/thing` escapes the
 *   destination and writes wherever it likes. Every entry is normalized and checked
 *   for escape before anything touches the disk.
 * - **Windows separators.** Wally's own packer notes that archives built on Windows
 *   can embed `\` in entry names, which then extract as one long filename on Unix
 *   instead of a directory tree. Newer Wally sanitizes on write, but packages
 *   published before that fix are still in the registry, so normalize on read too.
 */
function safeEntryPath(rawName: string, subject: string): string {
  const unified = rawName.replaceAll('\\', '/')

  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw unsafe(rawName, subject, 'it is an absolute path')
  }

  const normalized = normalize(unified)
  const segments = normalized.split(/[\\/]/)
  if (segments.includes('..')) {
    throw unsafe(rawName, subject, 'it points outside the package')
  }

  return segments.filter((s) => s !== '' && s !== '.').join(sep)
}

function unsafe(rawName: string, subject: string, why: string): RarnError {
  return new RarnError({
    code: Code.ArchiveUnsafePath,
    what: `The archive for ${subject} contains an unsafe path.`,
    where: subject,
    detail: `  ${rawName}  (${why})`,
    how: 'Rarn refuses to unpack this package. Please report it to the registry.',
  })
}

function hex(byte: number | undefined): string {
  return (byte ?? 0).toString(16).padStart(2, '0')
}
