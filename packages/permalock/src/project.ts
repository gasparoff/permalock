import path from 'node:path';
import { emptyLockfile, LOCKFILE_NAME, readLockfile, writeLockfile } from './lockfile.js';
import { resolve } from './resolve.js';
import { scanBuild, type ScanOptions } from './scan.js';
import type { Lockfile, Resolution, ResolveOptions, ScanResult } from './types.js';

export interface CheckProjectOptions extends ScanOptions {
  /** Project root. Default process.cwd() */
  cwd?: string;
  /** Build output directory. */
  dir: string;
  /** Lockfile path. Default <cwd>/permalock.json */
  lockfile?: string;
  /** Canonical origin, stored in a new lockfile. */
  site?: string;
  /** Redirects served outside the lockfile (framework config): url -> target */
  knownRedirects?: Map<string, string>;
  resolve?: ResolveOptions;
  /** Write the updated lockfile. Default true */
  write?: boolean;
  shard?: boolean | number;
}

export interface CheckProjectResult {
  resolution: Resolution;
  scan: ScanResult;
  lockfilePath: string;
  /** true when no lockfile existed before this run */
  created: boolean;
  /** true when the lockfile on disk was updated */
  written: boolean;
  previous: Lockfile;
}

export async function checkProject(opts: CheckProjectOptions): Promise<CheckProjectResult> {
  const cwd = opts.cwd ?? process.cwd();
  const lockfilePath = path.resolve(cwd, opts.lockfile ?? LOCKFILE_NAME);
  const existing = await readLockfile(lockfilePath);
  const previous = existing ?? emptyLockfile(opts.site);
  if (existing && opts.site && !existing.site) existing.site = opts.site.replace(/\/+$/, '');
  const scan = await scanBuild(path.resolve(cwd, opts.dir), opts);
  const knownRedirects = new Map(opts.knownRedirects ?? []);
  for (const [k, v] of scan.htmlRedirects) if (!knownRedirects.has(k)) knownRedirects.set(k, v);
  const resolution = resolve({ lock: previous, pages: scan.pages, knownRedirects, options: opts.resolve });
  if (existing && opts.site && previous.site !== resolution.lock.site) resolution.changed = true;
  let written = false;
  if ((opts.write ?? true) && (resolution.changed || !existing)) {
    await writeLockfile(lockfilePath, resolution.lock, { shard: opts.shard });
    written = true;
  }
  return { resolution, scan, lockfilePath, created: !existing, written, previous };
}
