import { addRedirect, retire } from './decide.js';
import type { Fetch } from './http.js';
import { checkLive, collectHistory, domainOf, type HistoricUrl } from './history.js';
import { normalizeBase } from './scan.js';
import type { Lockfile, Orphan } from './types.js';

export interface ImportOptions {
  fetch?: Fetch;
  wayback?: boolean;
  /** Only import URLs under this base path. */
  base?: string;
  /** Ask the live site first: keep redirects it already serves, skip URLs it still answers. */
  checkLive?: boolean;
}

export interface ImportResult {
  found: number;
  sources: Record<string, number>;
  errors: string[];
  added: HistoricUrl[];
  /** Redirects the live site already serves to a locked page, now in the lockfile. */
  adopted: { from: string; to: string }[];
  /** URLs the live site still answers with 200, from outside the build (left alone). */
  servedElsewhere: string[];
}

/** Add a domain's historic URLs to the lockfile, so each one gets a decision. Mutates `lock`. */
export async function importHistory(lock: Lockfile, domainInput: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const domain = domainOf(domainInput);
  if (!lock.site) lock.site = `https://${domain}`;
  const history = await collectHistory(domain, { fetch: opts.fetch, wayback: opts.wayback });
  const base = normalizeBase(opts.base);
  const isNew = (p: string) => !(p in lock.urls) && !(`${p}/` in lock.urls) && (!base || p === base || p.startsWith(`${base}/`));
  const unknown = history.urls.filter((h) => isNew(h.path));
  const res: ImportResult = {
    found: history.urls.length,
    sources: history.sources,
    errors: history.errors,
    added: [],
    adopted: [],
    servedElsewhere: [],
  };

  const live =
    opts.checkLive && unknown.length
      ? await checkLive(
          domain,
          unknown.map((u) => u.path),
          { fetch: opts.fetch },
        )
      : [];
  const byPath = new Map(live.map((l) => [l.path, l]));
  for (const u of unknown) {
    const l = byPath.get(u.path);
    if (l?.state === 'ok') {
      res.servedElsewhere.push(u.path);
      continue;
    }
    const target = l && (l.state === 'redirect' || l.state === 'chain') && l.final ? new URL(l.final) : undefined;
    // keep a redirect the site already serves, unless it only dumps the visitor on the home page
    if (target && target.host.replace(/^www\./, '') === domain && target.pathname !== '/' && lock.urls[target.pathname]?.type === 'page') {
      addRedirect(lock, u.path, target.pathname, 'adopted from live site');
      res.adopted.push({ from: u.path, to: target.pathname });
      continue;
    }
    lock.urls[u.path] = { type: 'page', origin: u.origin };
    res.added.push(u);
  }
  return res;
}

/** Apply one answer typed in `permalock resolve`. Returns false when the answer was not understood. */
export function applyAnswer(lock: Lockfile, orphan: Orphan, options: string[], answer: string, reason?: string): boolean {
  const a = answer.trim();
  if (a === 'g') retire(lock, orphan.url, reason || undefined);
  else if (/^\d+$/.test(a) && options[Number(a) - 1]) addRedirect(lock, orphan.url, options[Number(a) - 1]);
  else if (a.startsWith('/') || /^https:\/\//.test(a)) addRedirect(lock, orphan.url, a);
  else return false;
  return true;
}
