import { validateUrlKey } from './lockfile.js';
import { collapseRedirects, isAbsoluteUrl } from './resolve.js';
import type { Lockfile, ResolutionError } from './types.js';

export class DecisionError extends Error {}

/** Normalise user input ("blog/a", "https://site.com/blog/a") into a URL key. */
export function toUrlKey(input: string, site?: string): string {
  let s = input.trim();
  if (isAbsoluteUrl(s)) {
    const u = new URL(s);
    if (site && sameSite(u.origin, site)) s = u.pathname;
    else return u.href;
  }
  if (!s.startsWith('/')) s = '/' + s;
  try {
    // re-encode consistently (keeps existing %XX escapes)
    s = encodeURI(decodeURI(s));
  } catch {}
  return s;
}

export function sameSite(a: string, b: string): boolean {
  const host = (x: string) => {
    try {
      return new URL(x).host.replace(/^www\./, '');
    } catch {
      return x.replace(/^www\./, '');
    }
  };
  return host(a) === host(b);
}

/** Record a human decision: `from` permanently redirects to `to`. */
export function addRedirect(lock: Lockfile, fromInput: string, toInput: string, reason = 'manual'): ResolutionError[] {
  const from = toUrlKey(fromInput, lock.site);
  if (isAbsoluteUrl(from)) throw new DecisionError(`"${fromInput}" is not on this site${lock.site ? ` (${lock.site})` : ''}`);
  const problem = validateUrlKey(from);
  if (problem) throw new DecisionError(`${from} ${problem}`);
  const to = toUrlKey(toInput, lock.site);
  if (to === from) throw new DecisionError('a URL cannot redirect to itself');
  if (isAbsoluteUrl(to) && !/^https:\/\//i.test(to)) throw new DecisionError('external targets must use https://');
  lock.urls[from] = { type: 'redirect', to, reason };
  const errors = collapseRedirects(lock);
  return errors;
}

/** Record a human decision: `url` was removed on purpose. */
export function retire(lock: Lockfile, input: string, reason?: string): string[] {
  const url = toUrlKey(input, lock.site);
  if (isAbsoluteUrl(url)) throw new DecisionError(`"${input}" is not on this site`);
  const problem = validateUrlKey(url);
  if (problem) throw new DecisionError(`${url} ${problem}`);
  lock.urls[url] = reason ? { type: 'gone', reason } : { type: 'gone' };
  // redirects that pointed at it now point at nothing
  return Object.entries(lock.urls)
    .filter(([, e]) => e.type === 'redirect' && e.to === url)
    .map(([k]) => k);
}

/** Forget a URL entirely (it was never public, e.g. a draft). */
export function forget(lock: Lockfile, input: string): boolean {
  const url = toUrlKey(input, lock.site);
  if (!(url in lock.urls)) return false;
  delete lock.urls[url];
  return true;
}
