/**
 * Stable, searchable identifiers for everything Rarn can report.
 *
 * Borrowed from Yarn Berry's `YN0060` scheme. The value of a code is that it never
 * changes: message wording gets improved, translated, or reformatted, but `RN0210`
 * stays `RN0210` forever, so an issue report or a search still lands on the same
 * thing years later.
 *
 * Rules:
 * - A code, once shipped, is never reused for a different meaning.
 * - A retired code is left here with a `Retired:` note rather than deleted, so the
 *   number cannot be handed out twice.
 * - Ranges are grouped by layer, with gaps left inside each range on purpose.
 */
export const Code = {
  // RN0001-RN0009 — the CLI itself
  Unimplemented: 'RN0001',
  InvalidArguments: 'RN0002',
  InternalError: 'RN0003',
  PromptAborted: 'RN0004',

  // RN0010-RN0099 — manifest and project files
  ManifestNotFound: 'RN0010',
  ManifestUnreadable: 'RN0011',
  ManifestInvalid: 'RN0012',
  InvalidPackageName: 'RN0020',
  InvalidVersionRange: 'RN0021',
  InvalidVersion: 'RN0022',
  InvalidDependencySpec: 'RN0023',
  AliasCollision: 'RN0030',
  MissingPlacePath: 'RN0031',

  // RN0100-RN0199 — registry and network
  RegistryUnreachable: 'RN0100',
  RegistryBadResponse: 'RN0101',
  PackageNotFound: 'RN0110',
  VersionNotFound: 'RN0111',
  WallyVersionHeaderRejected: 'RN0120',
  RegistryAuthRequired: 'RN0121',
  NetworkBlocked: 'RN0130',

  // RN0200-RN0299 — resolution
  UnresolvableRange: 'RN0200',
  VersionConflict: 'RN0210',
  DuplicateMajorInstalled: 'RN0211',
  RealmViolation: 'RN0220',
  CircularDependency: 'RN0230',

  // RN0300-RN0399 — cache, download, extraction
  IntegrityMismatch: 'RN0300',
  DownloadFailed: 'RN0301',
  ArchiveUnreadable: 'RN0310',
  ArchiveUnsafePath: 'RN0311',
  CacheUnwritable: 'RN0320',

  // RN0400-RN0499 — project interpretation and linking
  ProjectFileUnsupported: 'RN0400',
  ModuleRootMissing: 'RN0401',
  LinkTargetMissing: 'RN0410',
  InstallSwapFailed: 'RN0420',
  InstallTargetNotOurs: 'RN0421',

  // RN0500-RN0599 — lockfile
  LockfileInvalid: 'RN0500',
  LockfileTooNew: 'RN0501',
  LockfileStale: 'RN0510',

  // RN0600-RN0699 — authentication and publishing
  NotLoggedIn: 'RN0600',
  LoginFailed: 'RN0601',
  TokenStoreUnwritable: 'RN0602',
  PackTooLarge: 'RN0610',
  PackEmpty: 'RN0611',
  UnpublishableRange: 'RN0620',
  PublishRejected: 'RN0621',
  VersionAlreadyPublished: 'RN0622',
  PublishForbidden: 'RN0623',
  PrivatePackage: 'RN0624',
  UnscopedPackage: 'RN0625',

  // RN0700-RN0799 — importing another package manager's manifest
  WallyManifestMissing: 'RN0700',
  WallyManifestInvalid: 'RN0701',
} as const

export type Code = (typeof Code)[keyof typeof Code]

/**
 * Codes that describe a warning rather than a failure.
 *
 * Kept in the same numbering space so that a code is unique across the whole tool
 * and a reader never has to ask which table a number came from.
 */
export const WarnCode = {
  ProjectFileFallback: 'RN0402',
  DuplicateMajorWarning: 'RN0212',
  CircularDependencyWarning: 'RN0231',
  CrossTreeDuplicate: 'RN0213',
} as const

export type WarnCode = (typeof WarnCode)[keyof typeof WarnCode]
