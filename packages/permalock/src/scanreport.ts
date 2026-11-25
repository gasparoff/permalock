import { checkLive, collectHistory, type HistoryOptions, type LiveCheck } from './history.js';
import { c } from './report.js';

type History = Awaited<ReturnType<typeof collectHistory>>;

export interface ScanSummary {
  domain: string;
  scannedAt: string;
  /** URLs the Wayback Machine saw answer 200. */
  published: number;
  /** URLs listed in sitemaps that the Wayback Machine never saw answer: not counted, not checked. */
  sitemapOnly?: number;
  checked: number;
  firstSeen?: string;
  sources: Record<string, number>;
  errors: string[];
  counts: { ok: number; redirect: number; chain: number; broken: number; error: number };
  broken: { path: string; status?: number; firstSeen?: string }[];
  chains: { path: string; hops: number; final?: string }[];
}

export function summarizeScan(history: History, live: LiveCheck[], published: number): ScanSummary {
  const counts = { ok: 0, redirect: 0, chain: 0, broken: 0, error: 0 };
  for (const l of live) counts[l.state]++;
  const firstSeen = new Map(history.urls.map((u) => [u.path, u.firstSeen]));
  return {
    domain: history.domain,
    scannedAt: new Date().toISOString(),
    published,
    checked: live.length,
    firstSeen: history.firstSeen,
    sources: history.sources,
    errors: history.errors,
    counts,
    broken: live.filter((l) => l.state === 'broken').map((l) => ({ path: l.path, status: l.status, firstSeen: firstSeen.get(l.path) })),
    chains: live.filter((l) => l.state === 'chain').map((l) => ({ path: l.path, hops: l.hops, final: l.final })),
  };
}

export interface ScanDomainOptions extends HistoryOptions {
  /** Max URLs checked on the live site; a larger history is sampled evenly. Default 2000 */
  max?: number;
  concurrency?: number;
  /** Timeout of each live check. Default 15000 */
  checkTimeoutMs?: number;
  /** After each live check, with its result. */
  onProgress?: (done: number, total: number, check: LiveCheck) => void;
  /** Called once the history is known, before the live checks start. */
  onHistory?: (published: number, checking: number) => void;
}

/** Find every URL a domain published and check how each one answers today. */
export async function scanDomain(domain: string, opts: ScanDomainOptions = {}): Promise<ScanSummary> {
  const history = await collectHistory(domain, opts);
  if (opts.wayback !== false && !('wayback' in history.sources)) {
    const why = history.errors.find((e) => e.startsWith('Wayback Machine: '))?.slice(17);
    if (why?.includes('answered 403'))
      throw new Error(
        `The Wayback Machine does not share the history of ${history.domain} (a site can ask to be left out), so there is nothing to check.`,
      );
    throw new Error(
      `The Wayback Machine is not answering right now${why ? ` (${why})` : ''}, so we can't tell which URLs the site published. It is often busy for a minute or two: try again shortly.`,
    );
  }
  // Only a 200 capture proves a URL was published: sitemaps list pages that may never have existed.
  const urls = opts.wayback === false ? history.urls : history.urls.filter((u) => u.captured);
  const paths = urls.map((u) => u.path);
  const max = opts.max ?? 2000;
  const sample = paths.length > max ? paths.filter((_, i) => i % Math.ceil(paths.length / max) === 0) : paths;
  opts.onHistory?.(paths.length, sample.length);
  const live = await checkLive(history.domain, sample, {
    fetch: opts.fetch,
    concurrency: opts.concurrency,
    timeoutMs: opts.checkTimeoutMs,
    onProgress: opts.onProgress,
  });
  const firstSeen = urls
    .map((u) => u.firstSeen)
    .filter(Boolean)
    .sort()[0];
  const summary = summarizeScan({ ...history, urls, firstSeen }, live, paths.length);
  if (urls.length < history.urls.length) summary.sitemapOnly = history.urls.length - urls.length;
  return summary;
}

const n = (x: number) => x.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '0%');
const SOURCE_NAMES: Record<string, string> = {
  wayback: 'Wayback Machine',
  sitemap: 'current sitemaps',
  'archived-sitemap': 'archived sitemaps',
};

export function headline(s: ScanSummary): string {
  const since = s.firstSeen ? ` since ${s.firstSeen.slice(0, 4)}` : '';
  const head = `${s.domain} has published ${n(s.published)} URLs${since}.`;
  if (s.checked < s.published)
    return `${head} Of the ${n(s.checked)} we checked, ${n(s.counts.broken)} ${s.counts.broken === 1 ? 'is' : 'are'} broken today.`;
  return `${head} ${n(s.counts.broken)} of them ${s.counts.broken === 1 ? 'is' : 'are'} broken today.`;
}

export function renderScanText(s: ScanSummary): string {
  const out: string[] = [];
  out.push('');
  out.push(c.bold(headline(s)));
  out.push(
    c.dim(
      `  sources: ${Object.entries(s.sources)
        .map(([k, v]) => `${SOURCE_NAMES[k] ?? k} ${n(v)}`)
        .join(' · ')}`,
    ),
  );
  if (s.sitemapOnly) out.push(c.dim(`  ${n(s.sitemapOnly)} more URLs appear only in sitemaps, never captured answering 200: not counted`));
  for (const e of s.errors) out.push(c.yellow(`  ! ${e}`));
  out.push('');
  out.push(`  ${c.green('✓')} ${n(s.counts.ok).padStart(7)}  answer 200`);
  out.push(`  ${c.cyan('→')} ${n(s.counts.redirect).padStart(7)}  answer one redirect`);
  out.push(`  ${c.yellow('⤳')} ${n(s.counts.chain).padStart(7)}  take two or more redirects`);
  out.push(`  ${c.red('✗')} ${n(s.counts.broken).padStart(7)}  are broken (404 or 410)  ${c.red(pct(s.counts.broken, s.checked))}`);
  if (s.counts.error) out.push(`  ${c.dim('?')} ${n(s.counts.error).padStart(7)}  did not answer`);
  if (s.broken.length) {
    out.push('');
    out.push(c.bold('  Broken URLs') + c.dim(s.broken.length > 15 ? ` (15 of ${n(s.broken.length)})` : ''));
    for (const b of s.broken.slice(0, 15)) out.push(`    ${b.path}${b.firstSeen ? c.dim(`  (first seen ${b.firstSeen})`) : ''}`);
  }
  out.push('');
  out.push(c.dim('  Every one of these was a link somebody shared, bookmarked or cited.'));
  out.push(`  Lock them: ${c.bold('npx permalock init')}  ·  Astro: ${c.bold('npx astro add @permalock/astro')}`);
  out.push('');
  return out.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderScanHtml(s: ScanSummary): string {
  const rows = s.broken
    .slice(0, 500)
    .map(
      (b) =>
        `<tr><td><a href="https://${esc(s.domain)}${esc(b.path)}">${esc(b.path)}</a></td><td>${b.status ?? ''}</td><td>${b.firstSeen ?? ''}</td></tr>`,
    )
    .join('');
  const bar = (label: string, v: number, cls: string) =>
    `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${s.checked ? (v / s.checked) * 100 : 0}%"></div></div><b>${n(v)}</b></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Permalock scan: ${esc(s.domain)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b675f;--line:#e4e0d6;--ok:#2f7d4f;--warn:#b7791f;--bad:#c0392b;--info:#2b6cb0}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ecebe6;--muted:#a19d93;--line:#2e2c28;--ok:#5fbf86;--warn:#e0a84a;--bad:#ef6f61;--info:#6ea8e8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px}h1{font-size:clamp(1.5rem,4vw,2.2rem);line-height:1.2;margin:.2em 0 .6em}
.muted{color:var(--muted)}.bar{display:grid;grid-template-columns:200px 1fr 80px;gap:12px;align-items:center;margin:8px 0}
.track{background:var(--line);height:12px;border-radius:6px;overflow:hidden}.fill{height:100%}.ok{background:var(--ok)}.redirect{background:var(--info)}.chain{background:var(--warn)}.bad{background:var(--bad)}
b{text-align:right;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}td:first-child{word-break:break-all}a{color:inherit}
code{background:var(--line);padding:2px 6px;border-radius:4px}
@media (max-width:560px){.bar{grid-template-columns:1fr 60px}.bar .track{grid-column:1/-1;grid-row:2}}
</style></head><body><main>
<p class="muted">Permalock scan · ${esc(s.scannedAt.slice(0, 10))}</p>
<h1>${esc(headline(s))}</h1>
<p class="muted">Sources: ${Object.entries(s.sources)
    .map(([k, v]) => `${esc(SOURCE_NAMES[k] ?? k)} ${n(v)}`)
    .join(
      ' · ',
    )}${s.checked < s.published ? ` · ${n(s.checked)} checked` : ''}${s.sitemapOnly ? ` · ${n(s.sitemapOnly)} sitemap-only URLs not counted` : ''}</p>
${bar('Answer 200', s.counts.ok, 'ok')}${bar('One redirect', s.counts.redirect, 'redirect')}${bar('Redirect chains', s.counts.chain, 'chain')}${bar('Broken (404/410)', s.counts.broken, 'bad')}
<p>Lock every URL you ever published: <code>npx permalock init</code></p>
${rows ? `<h2>Broken URLs</h2><table><thead><tr><th>URL</th><th>Status</th><th>First seen</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
</main></body></html>
`;
}
