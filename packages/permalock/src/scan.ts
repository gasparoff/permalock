import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fingerprintText, metaContent, metaRefreshTarget, normalizedText, sourceMarkers, words } from './text.js';
import type { BuiltPage, ScanResult } from './types.js';

export interface ScanOptions {
  /** Base path the site is served under, e.g. "/docs". Default "" */
  base?: string;
  /** How `about.html` is served: "strip" -> /about (default), "keep" -> /about.html */
  htmlExtension?: 'strip' | 'keep';
  /**
   * Trailing-slash convention of the URLs the site links to and serves.
   * "ignore" (default) follows the file layout: about/index.html -> /about/,
   * about.html -> /about.
   */
  trailingSlash?: 'always' | 'never' | 'ignore';
  /** Glob patterns (matched against URL paths) to ignore. */
  exclude?: string[];
  /** Identity per URL provided by a framework integration (overrides markers). */
  sources?: Map<string, string>;
  /**
   * Identity hook for framework integrations, called for pages without an
   * explicit id or a known source: receives the URL and the normalised words
   * of the page's main text.
   */
  identify?: (url: string, words: string[]) => string | undefined;
  /** Files read in parallel. Default 32 */
  concurrency?: number;
}

const DEFAULT_EXCLUDE = ['/404', '/404/', '/404.html', '/500', '/500/', '/500.html'];

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function normalizeBase(base?: string): string {
  if (!base || base === '/') return '';
  return '/' + base.replace(/^\/+|\/+$/g, '');
}

/** Map a file path relative to the build directory to the URL it is served at. */
export function fileToUrl(rel: string, opts: Pick<ScanOptions, 'base' | 'htmlExtension' | 'trailingSlash'> = {}): string {
  const parts = rel.split(path.sep).join('/');
  let url: string;
  if (parts === 'index.html') url = '/';
  else if (parts.endsWith('/index.html')) url = '/' + parts.slice(0, -'index.html'.length);
  else if (opts.htmlExtension === 'keep') url = '/' + parts;
  else url = '/' + parts.slice(0, -'.html'.length);
  const base = normalizeBase(opts.base);
  let full = base + url;
  const keepsExtension = opts.htmlExtension === 'keep' && full.endsWith('.html');
  if (opts.trailingSlash === 'never' && full.length > 1 && full.endsWith('/')) full = full.slice(0, -1);
  else if (opts.trailingSlash === 'always' && !full.endsWith('/') && !keepsExtension) full += '/';
  return encodeURI(full);
}

async function* walk(dir: string, rel = ''): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT' && rel === '') throw new Error(`Build directory not found: ${dir}`);
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile() && e.name.endsWith('.html')) yield r;
  }
}

export function resolveRefresh(target: string, fromUrl: string): string {
  try {
    const u = new URL(target, 'https://permalock.invalid' + fromUrl);
    if (u.origin === 'https://permalock.invalid') return u.pathname;
    return u.href;
  } catch {
    return target;
  }
}

/** Read a build directory and return every page it serves. */
export async function scanBuild(dir: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const excludes = [...DEFAULT_EXCLUDE.map((p) => normalizeBase(opts.base) + p), ...(opts.exclude ?? [])].map(globToRegExp);
  const files: string[] = [];
  for await (const f of walk(dir)) files.push(f);
  const pages: BuiltPage[] = [];
  const htmlRedirects = new Map<string, string>();
  const concurrency = opts.concurrency ?? 32;
  let i = 0;
  const results: (BuiltPage | { redirect: [string, string] } | null)[] = new Array(files.length);
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const rel = files[idx];
      const url = fileToUrl(rel, opts);
      if (excludes.some((re) => re.test(url))) {
        results[idx] = null;
        continue;
      }
      const file = path.join(dir, rel);
      const html = await fs.readFile(file, 'utf8');
      const refresh = metaRefreshTarget(html);
      if (refresh !== undefined) {
        results[idx] = { redirect: [url, resolveRefresh(refresh, url)] };
        continue;
      }
      const text = normalizedText(html);
      const ws = words(text);
      const fp = fingerprintText(text, ws);
      let source = opts.sources?.get(url);
      const explicit = metaContent(html, 'permalock:id');
      if (explicit) source = `id:${explicit}`;
      else if (!source) {
        const markers = sourceMarkers(html);
        if (markers.length === 1) source = markers[0];
        else if (opts.identify) source = opts.identify(url, ws);
      }
      const page: BuiltPage = { url, file, words: fp.words };
      if (source) page.source = source;
      if (fp.hash) page.hash = fp.hash;
      if (fp.sim) page.sim = fp.sim;
      results[idx] = page;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, worker));
  for (const r of results) {
    if (!r) continue;
    if ('redirect' in r) htmlRedirects.set(r.redirect[0], r.redirect[1]);
    else pages.push(r);
  }
  return { pages, htmlRedirects };
}

const CANDIDATE_DIRS = ['dist', 'build', 'out', '_site', 'public'];

/** Guess the build directory of a project. */
export async function detectBuildDir(cwd: string): Promise<string | undefined> {
  for (const d of CANDIDATE_DIRS) {
    try {
      await fs.access(path.join(cwd, d, 'index.html'));
      return path.join(cwd, d);
    } catch {}
  }
  return undefined;
}
