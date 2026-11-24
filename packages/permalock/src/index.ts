export * from './types.js';
export {
  LOCKFILE_NAME,
  LockfileError,
  emptyLockfile,
  parseLockfile,
  serializeLockfile,
  serializeEntry,
  readLockfile,
  writeLockfile,
  validateUrlKey,
  cloneLockfile,
  lockfilesEqual,
} from './lockfile.js';
export { scanBuild, fileToUrl, detectBuildDir, normalizeBase, globToRegExp, type ScanOptions } from './scan.js';
export { resolve, collapseRedirects, pathSimilarity, passes, isAbsoluteUrl, type ResolveInput } from './resolve.js';
export { addRedirect, retire, forget, toUrlKey, DecisionError } from './decide.js';
export { mergeLockfiles, type MergeResult } from './merge.js';
export { emit, writeEmitted, redirectHtml, htmlFileFor, EMIT_FORMATS, type EmitFormat, type EmitResult } from './emit.js';
export { verify, type VerifyOptions, type VerifyResult, type VerifyItem } from './verify.js';
export { collectHistory, waybackUrls, sitemapUrls, checkLive, parseSitemap, toSitePath, domainOf } from './history.js';
export { summarizeScan, renderScanText, renderScanHtml, type ScanSummary } from './scanreport.js';
export { checkProject, type CheckProjectOptions, type CheckProjectResult } from './project.js';
export { formatResolution, summaryLine, reasonLabel } from './report.js';
export {
  normalizedText,
  fingerprint,
  fingerprintText,
  simhash,
  simSimilarity,
  contentHash,
  fnv1a64,
  words,
  metaRefreshTarget,
  sourceMarkers,
  stripSourceMarkers,
} from './text.js';
