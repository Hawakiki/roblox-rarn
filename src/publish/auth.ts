import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Code } from '../util/codes.ts'
import { RarnError, RegistryError } from '../util/errors.ts'
import { isNotFoundError } from '../util/fs.ts'

/**
 * Where tokens live.
 *
 * Beside the cache rather than in it: the cache is disposable by design and
 * `rarn cache clean` empties it, which must not log the user out.
 */
export function authFilePath(): string {
  return join(homedir(), '.rarn', 'auth.json')
}

/**
 * Tokens are stored per API URL.
 *
 * A token issued by one registry means nothing to another, and sending it there
 * would hand a credential to a host that was never supposed to see it.
 */
interface AuthFile {
  tokens: Record<string, string>
}

// `path` is a parameter so the tests can point it somewhere that is not the home
// directory of whoever runs them — a real login lives there.
export async function readToken(
  apiUrl: string,
  path: string = authFilePath(),
): Promise<string | undefined> {
  const file = await readAuthFile(path)
  return file.tokens[normalizeUrl(apiUrl)]
}

export async function writeToken(
  apiUrl: string,
  token: string,
  path: string = authFilePath(),
): Promise<void> {
  const file = await readAuthFile(path)
  file.tokens[normalizeUrl(apiUrl)] = token
  await persist(path, file)
}

/** Returns whether there was anything to remove, so `logout` can say so honestly. */
export async function clearToken(apiUrl: string, path: string = authFilePath()): Promise<boolean> {
  const file = await readAuthFile(path)
  const key = normalizeUrl(apiUrl)
  if (file.tokens[key] === undefined) return false

  const { [key]: _removed, ...rest } = file.tokens
  file.tokens = rest
  if (Object.keys(file.tokens).length === 0) {
    await rm(path, { force: true })
    return true
  }
  await persist(path, file)
  return true
}

export async function requireToken(apiUrl: string, path: string = authFilePath()): Promise<string> {
  const token = await readToken(apiUrl, path)
  if (token !== undefined) return token

  throw new RarnError({
    code: Code.NotLoggedIn,
    what: `not logged in to ${apiUrl}.`,
    how: 'Run `rarn login` first.',
  })
}

/**
 * A file that holds something other than a token map is treated as no file.
 *
 * The alternative is refusing to run until the user hand-edits JSON they never
 * wrote, and the recovery from "no token" is just to log in again — a login
 * replaces the whole file, so the advice `RN0600` already gives is the repair.
 *
 * Checked entry by entry rather than cast, because what leaves here is sent as
 * `Authorization: Bearer <token>`. An object that got through went out as
 * `Bearer [object Object]`, and nothing on the way said the file was the problem.
 *
 * A file that is there but cannot be *read* is a different case, and throws.
 * Reading it as "no token" let `logout` report that nothing was stored while the
 * token was still on disk, and sent `publish` to `rarn login` over a file that
 * login could not read either.
 */
async function readAuthFile(path: string): Promise<AuthFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return { tokens: {} }
    throw new RarnError({
      code: Code.TokenStoreUnreadable,
      what: 'could not read the saved login.',
      where: path,
      how: 'Check the permissions on that file, or delete it and run `rarn login` again.',
      cause: error,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { tokens: {} }
  }

  const tokens = asMap(asMap(parsed)?.tokens)
  if (tokens === undefined) return { tokens: {} }
  return {
    tokens: Object.fromEntries(
      Object.entries(tokens).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  }
}

// An array passes `typeof === 'object'`, and spread into a map it becomes tokens
// keyed "0", "1", ...
function asMap(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

/**
 * Written beside the target and renamed over it, never written in place.
 *
 * Writing the file and restricting it afterwards left the token readable by every
 * account on the machine in between: the file was created with the default mode
 * (0644 under the usual umask), and a `chmod` whose failure was swallowed could
 * leave it there for good. A file created owner-only has no such moment. The
 * rename also means an interrupted write leaves the previous file rather than a
 * truncated one, which would read as logged out of every registry at once.
 *
 * Nothing is `chmod`ed afterwards, and that is not an omission: the rename puts a
 * new file in place of the old one rather than writing into it, so no earlier mode
 * survives to be corrected. Windows ignores the modes, and the ACL inherited from
 * the user profile is what restricts the file there, as it always was.
 */
async function persist(path: string, file: AuthFile): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    // Applies only to a directory created here. One that exists is left as it is.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // `wx` because a mode is applied only by the call that creates the file.
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temp, path)
  } catch (error) {
    // Left behind, it is a copy of the token that a later `logout` never touches.
    await rm(temp, { force: true }).catch(() => undefined)
    throw new RarnError({
      code: Code.TokenStoreUnwritable,
      what: 'could not save the login token.',
      where: path,
      cause: error,
      how: 'Check that your home directory is writable.',
    })
  }
}

/** Trailing slashes differ between config sources; the host is what identifies it. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export interface DeviceCodeGrant {
  readonly userCode: string
  readonly verificationUri: string
  readonly deviceCode: string
  readonly intervalMs: number
  readonly expiresAt: number
}

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/**
 * GitHub's device flow, which is how Wally authenticates and therefore how Rarn must.
 *
 * Chosen by the registry, not by us: the API accepts a GitHub token and nothing else,
 * and the device flow is the only variant that works without a browser redirect back
 * to a local port — which a CLI on a headless machine cannot receive.
 *
 * The `read:user` scope is all that is asked for. Publishing needs the registry to
 * know who you are and nothing more; a scope that could write to repositories would
 * be a far larger credential than the job requires.
 */
export async function startDeviceFlow(clientId: string): Promise<DeviceCodeGrant> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  })

  if (!response.ok) {
    throw new RegistryError({
      code: Code.LoginFailed,
      what: `GitHub refused the login request (${response.status}).`,
      where: GITHUB_DEVICE_CODE_URL,
      how: 'Check your connection and try again.',
    })
  }

  const body = (await response.json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    interval?: number
    expires_in?: number
  }

  if (body.device_code === undefined || body.user_code === undefined) {
    throw new RegistryError({
      code: Code.LoginFailed,
      what: 'GitHub returned a login response Rarn could not read.',
      where: GITHUB_DEVICE_CODE_URL,
    })
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? 'https://github.com/login/device',
    // GitHub rate-limits polling and answers `slow_down` if this is ignored.
    intervalMs: (body.interval ?? 5) * 1000,
    expiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
  }
}

/** Polls until the user finishes in their browser, or the code expires. */
export async function awaitDeviceToken(
  clientId: string,
  grant: DeviceCodeGrant,
  onTick?: () => void,
): Promise<string> {
  let waitMs = grant.intervalMs

  while (Date.now() < grant.expiresAt) {
    await sleep(waitMs)
    onTick?.()

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: grant.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const body = (await response.json()) as { access_token?: string; error?: string }
    if (body.access_token !== undefined) return body.access_token

    switch (body.error) {
      case 'authorization_pending':
        continue
      // Not something to recover from by retrying sooner — GitHub is saying the
      // interval it gave us is too aggressive, so back off and keep going.
      case 'slow_down':
        waitMs += 5000
        continue
      case 'expired_token':
      case 'access_denied':
        throw new RarnError({
          code: Code.LoginFailed,
          what:
            body.error === 'access_denied'
              ? 'the login was declined in the browser.'
              : 'the login code expired.',
          how: 'Run `rarn login` again.',
        })
      default:
        throw new RegistryError({
          code: Code.LoginFailed,
          what: `GitHub rejected the login: ${body.error ?? 'unknown error'}.`,
        })
    }
  }

  throw new RarnError({
    code: Code.LoginFailed,
    what: 'the login code expired before it was entered.',
    how: 'Run `rarn login` again.',
  })
}

/** Who a token belongs to. Used by `whoami`, which is otherwise unverifiable. */
export async function githubLogin(token: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { login?: string }
    return body.login
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
