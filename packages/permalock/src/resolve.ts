import { cloneLockfile, lockfilesEqual, validateUrlKey } from './lockfile.js';
import { simSimilarity } from './text.js';
import type {
  BuiltPage,
  Entry,
  Lockfile,
  Orphan,
  PageEntry,
  Resolution,
  ResolutionError,
  ResolveOptions,
  ResolvedRedirect,
  Suggestion,
} from './types.js';

export interface ResolveInput {
  lock: Lockfile;
  pages: BuiltPage[];
  /**
   * Redirects the site already serves outside the lockfile (framework config,
   * HTML redirect pages in the build): url -> target. A missing URL covered by
   * one of these is recorded as a redirect with reason "config".
   */
  knownRedirects?: Map<string, string>;
  options?: ResolveOptions;
}

export function isAbsoluteUrl(s: string) {
  return /^https?:\/\//i.test(s);
}

function tokens(url: string): string[] {
  return decodeURIComponentSafe(url)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !/^(index|html?|php|aspx?)$/.test(t));
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Similarity of two URL paths in [0, 1], weighted towards the last segment. */
export function pathSimilarity(a: string, b: string): number {
  const ta = tokens(a),
    tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const last = (u: string) => {
    const segs = decodeURIComponentSafe(u).toLowerCase().split('/').filter(Boolean);
    return (segs[segs.length - 1] ?? '').replace(/\.(html?|php|aspx?)$/, '');
  };
  const la = bigrams(last(a)),
    lb = bigrams(last(b));
  let dice = 0;
  if (la.length && lb.length) {
    const counts = new Map<string, number>();
    for (const g of la) counts.set(g, (counts.get(g) ?? 0) + 1);
    let inter = 0;
    for (const g of lb) {
      const c = counts.get(g) ?? 0;
      if (c > 0) {
        inter++;
        counts.set(g, c - 1);
      }
    }
    dice = (2 * inter) / (la.length + lb.length);
  }
  const sa = new Set(ta),
    sb = new Set(tb);
  let common = 0;
  for (const t of sa) if (sb.has(t)) common++;
  const jaccard = common / (sa.size + sb.size - common);
  return 0.7 * dice + 0.3 * jaccard;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const LOCALE_RE = /^[a-z]{2}(?:-[a-z0-9]{2,4})?$/i;

/** A locale-looking segment among the first two of a path ("/fr/...", "/docs/pt-br/..."). */
export function localeOf(url: string): string | undefined {
  return url
    .split('/')
    .slice(1, 3)
    .find((s) => LOCALE_RE.test(s))
    ?.toLowerCase();
}

/**
 * A page never moves to another language on its own: an untranslated fallback
 * page in /fr/ has the same text as the removed /en/ page, but is not its new home.
 */
function sameLanguage(a: string, b: string) {
  const la = localeOf(a),
    lb = localeOf(b);
  return !la || !lb || la === lb;
}

export function resolve(input: ResolveInput): Resolution {
  const opts = input.options ?? {};
  const autoThreshold = opts.autoThreshold === undefined ? 0.94 : opts.autoThreshold;
  const suggestThreshold = opts.suggestThreshold ?? 0.8;
  const pathThreshold = opts.pathThreshold ?? 0.6;
  const margin = opts.margin ?? 0.05;

  const before = input.lock;
  const lock = cloneLockfile(before);
  const urls = lock.urls;
  const built = new Map<string, BuiltPage>();
  for (const p of input.pages) built.set(p.url, p);

  const res: Resolution = {
    lock,
    added: [],
    revived: [],
    redirected: [],
    collapsed: [],
    orphans: [],
    errors: [],
    changed: false,
  };

  // Step 1: built pages
  for (const p of input.pages) {
    const prev = urls[p.url];
    if (!prev) res.added.push(p.url);
    else if (prev.type !== 'page') res.revived.push({ url: p.url, was: prev.type });
    const entry: PageEntry = { type: 'page' };
    if (p.source) entry.source = p.source;
    if (p.hash) entry.hash = p.hash;
    if (p.sim) entry.sim = p.sim;
    // keep unknown fields of an existing page entry
    if (prev && prev.type === 'page') {
      for (const [k, v] of Object.entries(prev)) {
        if (!['type', 'source', 'hash', 'sim', 'origin', 'to', 'reason'].includes(k)) entry[k] = v;
      }
    }
    urls[p.url] = entry;
  }

  // indexes over the build
  const bySource = new Map<string, BuiltPage[]>();
  const byHash = new Map<string, BuiltPage[]>();
  for (const p of input.pages) {
    if (p.source) push(bySource, p.source, p);
    if (p.hash) push(byHash, p.hash, p);
  }
  const withSim = input.pages.filter((p) => p.sim);

  // Step 2: missing pages
  const missing = Object.keys(urls)
    .filter((u) => urls[u].type === 'page' && !built.has(u))
    .sort();
  for (const u of missing) {
    const prev = urls[u] as PageEntry;
    const known = input.knownRedirects?.get(u);
    if (known !== undefined) {
      setRedirect(u, known, 'config');
      continue;
    }
    // 2.1 same source
    const here = (list: BuiltPage[] | undefined) => list?.filter((p) => sameLanguage(u, p.url));
    if (prev.source) {
      const c = here(bySource.get(prev.source));
      if (c && c.length === 1) {
        setRedirect(u, c[0].url, 'same-source');
        continue;
      }
    }
    // 2.2 same content
    if (prev.hash) {
      const c = here(byHash.get(prev.hash));
      if (c && c.length === 1) {
        setRedirect(u, c[0].url, 'same-content');
        continue;
      }
    }
    // 2.3 similar content
    let best: Suggestion | undefined;
    if (prev.sim) {
      let first = { url: '', score: -1 };
      let second = -1;
      for (const p of withSim) {
        if (!sameLanguage(u, p.url)) continue;
        const s = simSimilarity(prev.sim, p.sim!);
        if (s > first.score) {
          second = first.score;
          first = { url: p.url, score: s };
        } else if (s > second) second = s;
      }
      if (first.score >= 0) {
        if (autoThreshold !== false && first.score >= autoThreshold && first.score - second >= margin) {
          setRedirect(u, first.url, `similar:${round2(first.score).toFixed(2)}`);
          continue;
        }
        if (first.score >= suggestThreshold) best = { to: first.url, score: round2(first.score), basis: 'content' };
      }
    }
    // 2.4 path suggestion
    if (!best) {
      let top = { url: '', score: 0 };
      for (const p of input.pages) {
        const s = pathSimilarity(u, p.url);
        if (s > top.score) top = { url: p.url, score: s };
      }
      if (top.score >= pathThreshold) best = { to: top.url, score: round2(top.score), basis: 'path' };
    }
    const orphan: Orphan = { url: u };
    if (best) orphan.suggestion = best;
    if (prev.origin) orphan.origin = prev.origin;
    res.orphans.push(orphan);
  }

  // Redirects the site serves from its own configuration (framework config,
  // generator aliases, i18n fallbacks) are public URLs too: lock them, and
  // follow the configuration when it changes their target.
  const known = input.knownRedirects ?? new Map<string, string>();
  for (const [from, to] of known) {
    if (from === to || validateUrlKey(from)) continue;
    const prev = urls[from];
    if (!prev) setRedirect(from, to, 'config');
    else if (prev.type === 'redirect' && prev.reason === 'config' && prev.to !== to) prev.to = to;
  }
  // A configuration redirect that the site stopped serving, with no page in
  // its place, would break: it needs a decision like any orphan.
  for (const u of Object.keys(urls).sort()) {
    const e = urls[u];
    if (e.type !== 'redirect' || e.reason !== 'config' || known.has(u) || built.has(u)) continue;
    res.orphans.push({ url: u, suggestion: { to: e.to, score: 1, basis: 'redirect' } });
  }

  // Step 3: redirect hygiene
  res.errors.push(...collapseRedirects(lock, res.collapsed));

  res.changed = !lockfilesEqual(before, lock);
  return res;

  function setRedirect(from: string, to: string, reason: string) {
    urls[from] = { type: 'redirect', to, reason };
    res.redirected.push({ from, to, reason });
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/**
 * Collapse chains (A->B->C becomes A->C) and report cycles and broken
 * redirects. Mutates the lockfile.
 */
export function collapseRedirects(lock: Lockfile, collapsed: { from: string; was: string; now: string }[] = []): ResolutionError[] {
  const urls = lock.urls;
  const errors: ResolutionError[] = [];
  for (const from of Object.keys(urls).sort()) {
    const e = urls[from];
    if (e.type !== 'redirect') continue;
    const seen = new Set([from]);
    let target = e.to;
    let cycle = false;
    while (!isAbsoluteUrl(target) && urls[target]?.type === 'redirect') {
      if (seen.has(target)) {
        cycle = true;
        break;
      }
      seen.add(target);
      target = (urls[target] as Entry & { to: string }).to;
    }
    if (cycle || target === from) {
      errors.push({ url: from, kind: 'cycle', message: `redirect loop: ${[...seen].join(' -> ')} -> ${target}` });
      continue;
    }
    if (target !== e.to) {
      collapsed.push({ from, was: e.to, now: target });
      e.to = target;
    }
    if (isAbsoluteUrl(target)) continue;
    const t = urls[target];
    if (!t) errors.push({ url: from, kind: 'broken-redirect', message: `redirects to ${target}, which is not a known page` });
    else if (t.type === 'gone') errors.push({ url: from, kind: 'redirect-to-gone', message: `redirects to ${target}, which was removed` });
  }
  return errors;
}

export function passes(r: Pick<Resolution, 'orphans' | 'errors'>) {
  return r.orphans.length === 0 && r.errors.length === 0;
}

export type { ResolvedRedirect };
