import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FORMAT_VERSION, type Entry, type Lockfile } from './types.js';

export const LOCKFILE_NAME = 'permalock.json';

const ENTRY_KEY_ORDER = ['type', 'to', 'source', 'hash', 'sim', 'origin', 'reason'];
const TOP_KNOWN = new Set(['permalock', 'site', 'urls']);

export class LockfileError extends Error {}

export function emptyLockfile(site?: string): Lockfile {
  return { permalock: FORMAT_VERSION, ...(site ? { site: stripSlash(site) } : {}), urls: {} };
}

function stripSlash(s: string) {
  return s.replace(/\/+$/, '');
}

/** Compare by UTF-16 code units, as the spec requires (not locale-aware). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeEntry(entry: Entry): string {
  const keys = Object.keys(entry).filter((k) => (entry as any)[k] !== undefined);
  const known = ENTRY_KEY_ORDER.filter((k) => keys.includes(k));
  const unknown = keys.filter((k) => !ENTRY_KEY_ORDER.includes(k)).sort(compareKeys);
  const parts = [...known, ...unknown].map((k) => `${JSON.stringify(k)}: ${JSON.stringify((entry as any)[k])}`);
  return `{ ${parts.join(', ')} }`;
}

/** Deterministic, merge-friendly serialisation (spec 2.7). */
export function serializeLockfile(lock: Lockfile): string {
  const lines: string[] = ['{'];
  const top: string[] = [];
  top.push(`  "permalock": ${JSON.stringify(lock.permalock)}`);
  if (lock.site !== undefined) top.push(`  "site": ${JSON.stringify(lock.site)}`);
  for (const [k, v] of Object.entries(lock.extra ?? {})) top.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const keys = Object.keys(lock.urls).sort(compareKeys);
  if (keys.length === 0) {
    top.push('  "urls": {}');
  } else {
    const body = keys.map((k) => `    ${JSON.stringify(k)}: ${serializeEntry(lock.urls[k])}`).join(',\n');
    top.push(`  "urls": {\n${body}\n  }`);
  }
  lines.push(top.join(',\n'));
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function validateUrlKey(key: string): string | undefined {
  if (!key.startsWith('/')) return 'must start with "/"';
  if (key.startsWith('//')) return 'must not start with "//"';
  if (/[?#]/.test(key)) return 'must not contain a query string or fragment';
  if (/\s/.test(key)) return 'must not contain whitespace (percent-encode it)';
  return undefined;
}

export function parseLockfile(text: string, file = LOCKFILE_NAME): Lockfile {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const conflict = /^(<{7}|={7}|>{7})/m.test(text);
    throw new LockfileError(
      conflict
        ? `${file} contains git conflict markers. Run "permalock merge-driver --install" to let git merge it, or resolve by hand.`
        : `${file} is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LockfileError(`${file}: expected an object`);
  if (typeof raw.permalock !== 'number') throw new LockfileError(`${file}: missing "permalock" format version`);
  if (raw.permalock > FORMAT_VERSION)
    throw new LockfileError(`${file} uses format ${raw.permalock}; this version of permalock understands up to ${FORMAT_VERSION}. Upgrade permalock.`);
  if (!raw.urls || typeof raw.urls !== 'object' || Array.isArray(raw.urls)) throw new LockfileError(`${file}: "urls" must be an object`);
  const urls: Record<string, Entry> = {};
  for (const [key, value] of Object.entries<any>(raw.urls)) {
    const problem = validateUrlKey(key);
    if (problem) throw new LockfileError(`${file}: URL ${JSON.stringify(key)} ${problem}`);
    if (!value || typeof value !== 'object') throw new LockfileError(`${file}: entry for ${key} must be an object`);
    if (value.type === 'redirect') {
      if (typeof value.to !== 'string' || !value.to) throw new LockfileError(`${file}: redirect ${key} needs a "to"`);
    } else if (value.type !== 'page' && value.type !== 'gone') {
      throw new LockfileError(`${file}: entry for ${key} has unknown type ${JSON.stringify(value.type)}`);
    }
    urls[key] = { ...value };
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!TOP_KNOWN.has(k)) extra[k] = v;
  return {
    permalock: raw.permalock,
    ...(typeof raw.site === 'string' ? { site: raw.site } : {}),
    urls,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function shardFileName(name: string) {
  return `permalock.${name}.json`;
}

const SHARD_RE = /^permalock\.([A-Za-z0-9_-]+)\.json$/;

async function listShards(dir: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => SHARD_RE.test(n) && n !== 'permalock.schema.json').sort(compareKeys);
}

/**
 * Read `permalock.json` plus any `permalock.<shard>.json` next to it.
 * Returns undefined when no lockfile exists.
 */
export async function readLockfile(file: string): Promise<Lockfile | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const lock = parseLockfile(text, path.basename(file));
  if (path.basename(file) !== LOCKFILE_NAME) return lock;
  const dir = path.dirname(file);
  for (const shard of await listShards(dir)) {
    const part = parseLockfile(await fs.readFile(path.join(dir, shard), 'utf8'), shard);
    for (const [k, v] of Object.entries(part.urls)) {
      if (k in lock.urls) throw new LockfileError(`${k} appears both in ${shard} and in another lockfile shard`);
      lock.urls[k] = v;
    }
  }
  return lock;
}

export interface WriteOptions {
  /** Split into shards: true = automatic, a number = minimum URLs per shard. */
  shard?: boolean | number;
}

function firstSegment(url: string): string | undefined {
  const m = /^\/([^/]+)\//.exec(url);
  return m && /^[A-Za-z0-9_-]+$/.test(m[1]) ? m[1] : undefined;
}

/** Write the lockfile (and shards). Returns the list of files written. */
export async function writeLockfile(file: string, lock: Lockfile, opts: WriteOptions = {}): Promise<string[]> {
  const dir = path.dirname(file);
  const existingShards = path.basename(file) === LOCKFILE_NAME ? await listShards(dir) : [];
  const shardMode = opts.shard ?? (existingShards.length > 0 ? true : false);
  const written: string[] = [];
  if (!shardMode || path.basename(file) !== LOCKFILE_NAME) {
    await writeIfChanged(file, serializeLockfile(lock));
    written.push(file);
    for (const s of existingShards) await fs.rm(path.join(dir, s));
    return written;
  }
  const min = typeof shardMode === 'number' ? shardMode : 500;
  const groups = new Map<string, string[]>();
  for (const url of Object.keys(lock.urls)) {
    const seg = firstSegment(url);
    if (!seg) continue;
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg)!.push(url);
  }
  const main: Lockfile = { ...lock, urls: { ...lock.urls } };
  const keep = new Set<string>();
  for (const [seg, urls] of groups) {
    if (urls.length < min) continue;
    const part: Lockfile = { permalock: lock.permalock, urls: {} };
    for (const u of urls) {
      part.urls[u] = lock.urls[u];
      delete main.urls[u];
    }
    const name = shardFileName(seg);
    keep.add(name);
    await writeIfChanged(path.join(dir, name), serializeLockfile(part));
    written.push(path.join(dir, name));
  }
  for (const s of existingShards) if (!keep.has(s)) await fs.rm(path.join(dir, s));
  await writeIfChanged(file, serializeLockfile(main));
  written.push(file);
  return written;
}

async function writeIfChanged(file: string, content: string) {
  try {
    if ((await fs.readFile(file, 'utf8')) === content) return;
  } catch {}
  await fs.writeFile(file, content);
}

export function cloneLockfile(lock: Lockfile): Lockfile {
  return JSON.parse(JSON.stringify(lock));
}

export function lockfilesEqual(a: Lockfile, b: Lockfile): boolean {
  return serializeLockfile(a) === serializeLockfile(b);
}
