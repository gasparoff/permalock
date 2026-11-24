import { isAbsoluteUrl } from './resolve.js';
import { pool, probe, withRetry, type Fetch } from './http.js';
import type { Entry, Lockfile } from './types.js';

export type VerifyStatus = 'pass' | 'fail' | 'soft' | 'error';

export interface VerifyItem {
  url: string;
  type: Entry['type'];
  status: VerifyStatus;
  expected: string;
  observed: string;
  hint?: string;
}

export interface VerifyResult {
  origin: string;
  items: VerifyItem[];
  counts: Record<VerifyStatus, number>;
}

export interface VerifyOptions {
  /** Origin to test, e.g. a preview deployment. Default: lockfile "site". */
  against?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Only check this many URLs, chosen evenly. */
  sample?: number;
  fetch?: Fetch;
  onProgress?: (done: number, total: number) => void;
}

const isPermanent = (s: number) => s === 301 || s === 308;

function describe(status: number, location?: string) {
  return location ? `${status} -> ${location}` : String(status);
}

function slashTwin(a: string, b: string) {
  return a !== b && a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

export async function verify(lock: Lockfile, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const originInput = opts.against ?? lock.site;
  if (!originInput) throw new Error('No origin to verify: pass --against <url> or set "site" in permalock.json');
  const origin = new URL(originInput).origin;
  const basePath = new URL(originInput).pathname.replace(/\/$/, '');
  let urls = Object.keys(lock.urls).sort();
  if (opts.sample && opts.sample < urls.length) {
    const step = urls.length / opts.sample;
    urls = Array.from({ length: opts.sample }, (_, i) => urls[Math.floor(i * step)]);
  }
  const abs = (p: string) => (isAbsoluteUrl(p) ? p : origin + basePath + p);
  const popts = { fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  let done = 0;
  const items = await pool(urls, opts.concurrency ?? 8, async (url): Promise<VerifyItem> => {
    const e = lock.urls[url];
    try {
      return await withRetry(() => check(url, e));
    } catch (err) {
      return { url, type: e.type, status: 'error', expected: expectation(e), observed: (err as Error).message };
    } finally {
      opts.onProgress?.(++done, urls.length);
    }
  });

  async function check(url: string, e: Entry): Promise<VerifyItem> {
    const target = abs(url);
    const base = { url, type: e.type, expected: expectation(e) };
    if (e.type === 'page') {
      const h = await probe(target, popts);
      if (h.status === 200) return { ...base, status: 'pass', observed: '200' };
      const observed = describe(h.status, h.location);
      if (h.status >= 300 && h.status < 400 && h.location && slashTwin(new URL(h.location).pathname, new URL(target).pathname))
        return {
          ...base,
          status: 'fail',
          observed,
          hint: 'The host adds a trailing-slash redirect. Align your build trailing-slash setting with the host, or every redirect to this page becomes two hops.',
        };
      return { ...base, status: 'fail', observed };
    }
    if (e.type === 'gone') {
      const h = await probe(target, popts);
      if (h.status === 410 || h.status === 404) return { ...base, status: 'pass', observed: String(h.status) };
      return { ...base, status: 'fail', observed: describe(h.status, h.location) };
    }
    // redirect
    const want = abs(e.to);
    const h = await probe(target, { ...popts, wantBody: true });
    if (h.status === 200 && h.refresh) {
      const ok = sameUrl(h.refresh, want);
      return {
        ...base,
        status: ok ? 'soft' : 'fail',
        observed: `200 + meta refresh -> ${h.refresh}`,
        hint: ok ? 'Soft redirect: the host cannot answer 301, or the redirect is not configured on the host.' : undefined,
      };
    }
    if (!(h.status >= 300 && h.status < 400) || !h.location) return { ...base, status: 'fail', observed: describe(h.status) };
    if (!isPermanent(h.status))
      return { ...base, status: 'fail', observed: describe(h.status, h.location), hint: 'Temporary redirect: use 301 or 308.' };
    if (!sameUrl(h.location, want)) {
      const second = await probe(h.location, popts);
      const twoHop = second.status >= 300 && second.status < 400 && second.location && sameUrl(second.location, want);
      return {
        ...base,
        status: 'fail',
        observed: `${describe(h.status, h.location)}${twoHop ? ` -> ${second.status} -> ${second.location}` : ''}`,
        hint: twoHop ? 'Two hops instead of one (often a trailing-slash rule on the host).' : undefined,
      };
    }
    const t = await probe(h.location, popts);
    if (t.status !== 200)
      return { ...base, status: 'fail', observed: `${describe(h.status, h.location)}, target answers ${describe(t.status, t.location)}` };
    return { ...base, status: 'pass', observed: describe(h.status, h.location) };
  }

  const counts = { pass: 0, fail: 0, soft: 0, error: 0 };
  for (const i of items) counts[i.status]++;
  return { origin: origin + basePath, items, counts };
}

function sameUrl(a: string, b: string) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '') && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

function expectation(e: Entry): string {
  if (e.type === 'page') return '200';
  if (e.type === 'gone') return '410 (or 404)';
  return `301 -> ${e.to} -> 200`;
}
