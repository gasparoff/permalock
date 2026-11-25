import { pool, trace, USER_AGENT, withRetry, type Fetch } from './http.js';

export interface HistoricUrl {
  path: string;
  /** "wayback", "sitemap" or "archived-sitemap" (first seen source wins) */
  origin: string;
  /** Earliest capture, YYYY-MM-DD, when known. */
  firstSeen?: string;
  /** The Wayback Machine saw this URL answer 200: proof it was published. */
  captured?: boolean;
}

export interface HistoryOptions {
  fetch?: Fetch;
  /** Max rows from the Wayback CDX API. Default 50000 */
  limit?: number;
  wayback?: boolean;
  sitemaps?: boolean;
  timeoutMs?: number;
  onStep?: (msg: string) => void;
  /** Called when a source finishes: its name and how many URLs it found (or the error). */
  onSource?: (name: string, count: number, error?: string) => void;
}

const ASSET_RE = /\.(css|js|mjs|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|zip|gz|map|rss|atom)$/i;

export function domainOf(input: string): string {
  const s = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(s).host.replace(/^www\./, '');
}

/** Normalise a historic absolute URL to a path on `domain`, or undefined. */
export function toSitePath(raw: string, domain: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (u.host.replace(/^www\./, '').replace(/:80$|:443$/, '') !== domain) return undefined;
  let p = u.pathname;
  if (!p || p.length > 300) return undefined;
  if (ASSET_RE.test(p)) return undefined;
  if (/\/(wp-admin|wp-includes|wp-json|cgi-bin|xmlrpc\.php|feed)(\/|$)/i.test(p)) return undefined;
  // collapse duplicate slashes, keep encoding stable
  p = p.replace(/\/{2,}/g, '/');
  try {
    p = encodeURI(decodeURI(p));
  } catch {}
  return p;
}

async function getText(url: string, opts: HistoryOptions): Promise<string> {
  const f = opts.fetch ?? fetch;
  return withRetry(async () => {
    const res = await f(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
  }, 2);
}

function ymd(ts: string) {
  return ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : undefined;
}

/** URLs of `domain` that the Wayback Machine captured with a 200 HTML response. */
export async function waybackUrls(domain: string, opts: HistoryOptions = {}): Promise<HistoricUrl[]> {
  const limit = opts.limit ?? 50000;
  const out = new Map<string, HistoricUrl>();
  let resumeKey: string | undefined;
  let fetched = 0;
  do {
    const q = new URLSearchParams({
      url: `${domain}/*`,
      output: 'json',
      fl: 'original,timestamp',
      collapse: 'urlkey',
      limit: String(Math.min(10000, limit - fetched)),
      showResumeKey: 'true',
    });
    q.append('filter', 'statuscode:200');
    q.append('filter', 'mimetype:text/html');
    if (resumeKey) q.set('resumeKey', resumeKey);
    const text = await getText(`https://web.archive.org/cdx/search/cdx?${q}`, opts);
    const rows: string[][] = text.trim() ? JSON.parse(text) : [];
    resumeKey = undefined;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 0) {
        // an empty row precedes the resume key
        resumeKey = rows[i + 1]?.[0];
        break;
      }
      fetched++;
      const p = toSitePath(r[0], domain);
      if (!p) continue;
      const seen = ymd(r[1]);
      const prev = out.get(p);
      if (!prev) out.set(p, { path: p, origin: 'wayback', firstSeen: seen });
      else if (seen && (!prev.firstSeen || seen < prev.firstSeen)) prev.firstSeen = seen;
    }
    opts.onStep?.(`Wayback Machine: ${out.size} URLs so far`);
  } while (resumeKey && fetched < limit);
  return [...out.values()];
}

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (block: string) => [...block.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex\b/i.test(xml)) return { urls: [], sitemaps: locs(xml) };
  return { urls: locs(xml), sitemaps: [] };
}

/** URLs listed in the site's current sitemaps (robots.txt + common locations). */
export async function sitemapUrls(domain: string, opts: HistoryOptions = {}): Promise<HistoricUrl[]> {
  const origin = `https://${domain}`;
  const queue: string[] = [];
  try {
    const robots = await getText(`${origin}/robots.txt`, { ...opts, timeoutMs: 15000 });
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  } catch {}
  if (!queue.length) queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap_index.xml`);
  return crawlSitemaps(queue, domain, 'sitemap', opts);
}

async function crawlSitemaps(queue: string[], domain: string, origin: string, opts: HistoryOptions): Promise<HistoricUrl[]> {
  const seen = new Set<string>();
  const out = new Map<string, HistoricUrl>();
  while (queue.length && seen.size < 200) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml: string;
    try {
      xml = await getText(sm, { ...opts, timeoutMs: 20000 });
    } catch {
      continue;
    }
    const { urls, sitemaps } = parseSitemap(xml);
    queue.push(...sitemaps);
    for (const u of urls) {
      const p = toSitePath(u, domain);
      if (p && !out.has(p)) out.set(p, { path: p, origin });
    }
  }
  return [...out.values()];
}

/** Old sitemaps archived by the Wayback Machine. */
export async function archivedSitemapUrls(domain: string, opts: HistoryOptions = {}): Promise<HistoricUrl[]> {
  const q = new URLSearchParams({ url: `${domain}/*`, output: 'json', fl: 'original,timestamp', collapse: 'digest', limit: '60' });
  q.append('filter', 'statuscode:200');
  q.append('filter', 'original:.*sitemap[^/]*\\.xml.*');
  let rows: string[][] = [];
  try {
    const text = await getText(`https://web.archive.org/cdx/search/cdx?${q}`, opts);
    rows = text.trim() ? JSON.parse(text) : [];
  } catch {
    return [];
  }
  const snaps = rows.slice(1).filter((r) => r.length === 2).map(([orig, ts]) => `https://web.archive.org/web/${ts}id_/${orig}`);
  return crawlSitemaps(snaps, domain, 'archived-sitemap', opts);
}

/** Every URL the domain is known to have published, from all sources. */
export async function collectHistory(domainInput: string, opts: HistoryOptions = {}) {
  const domain = domainOf(domainInput);
  const sources: Record<string, number> = {};
  const all = new Map<string, HistoricUrl>();
  const errors: string[] = [];
  const add = (list: HistoricUrl[], name: string) => {
    sources[name] = list.length;
    opts.onSource?.(name, list.length);
    for (const h of list) {
      if (name === 'wayback') h.captured = true;
      const prev = all.get(h.path);
      if (!prev) all.set(h.path, h);
      else {
        if (h.firstSeen && (!prev.firstSeen || h.firstSeen < prev.firstSeen)) prev.firstSeen = h.firstSeen;
        if (h.captured) prev.captured = true;
      }
    }
  };
  const fail = (name: string, message: string) => {
    errors.push(message);
    opts.onSource?.(name, 0, message);
  };
  const tasks: Promise<void>[] = [];
  if (opts.wayback !== false) {
    tasks.push(
      waybackUrls(domain, opts).then((l) => add(l, 'wayback'), (e) => fail('wayback', `Wayback Machine: ${e.message}`)),
      archivedSitemapUrls(domain, opts).then((l) => add(l, 'archived-sitemap'), (e) => fail('archived-sitemap', `archived sitemaps: ${e.message}`)),
    );
  }
  if (opts.sitemaps !== false)
    tasks.push(sitemapUrls(domain, opts).then((l) => add(l, 'sitemap'), (e) => fail('sitemap', `sitemaps: ${e.message}`)));
  await Promise.all(tasks);
  const urls = [...all.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const firstSeen = urls.map((u) => u.firstSeen).filter(Boolean).sort()[0];
  return { domain, urls, sources, errors, firstSeen };
}

export type LiveState = 'ok' | 'redirect' | 'chain' | 'broken' | 'error';

export interface LiveCheck {
  path: string;
  state: LiveState;
  status?: number;
  hops: number;
  final?: string;
  detail?: string;
}

/** Check how each path behaves today on the live site. */
export async function checkLive(
  domain: string,
  paths: string[],
  opts: { fetch?: Fetch; concurrency?: number; timeoutMs?: number; onProgress?: (d: number, t: number) => void } = {},
): Promise<LiveCheck[]> {
  let done = 0;
  return pool(paths, opts.concurrency ?? 8, async (p) => {
    try {
      const hops = await withRetry(() => trace(`https://${domain}${p}`, { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 15000 }));
      const last = hops[hops.length - 1];
      const n = hops.length - 1;
      const final = n > 0 ? hops[hops.length - 1].url : undefined;
      let state: LiveState;
      if (last.status === 200) state = n === 0 ? 'ok' : n === 1 ? 'redirect' : 'chain';
      else if (last.status === 404 || last.status === 410) state = 'broken';
      else if (last.status >= 300 && last.status < 400) state = 'chain';
      else state = 'error';
      return { path: p, state, status: last.status, hops: n, final };
    } catch (e) {
      return { path: p, state: 'error' as const, hops: 0, detail: (e as Error).message };
    } finally {
      opts.onProgress?.(++done, paths.length);
    }
  });
}
