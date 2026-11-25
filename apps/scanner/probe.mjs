// Why does a domain show what it shows? Raw Wayback counts, sitemaps and the scan, side by side.
// node apps/scanner/probe.mjs example.com [...]
import { renderScanText, scanDomain, sitemapUrls } from 'permalock';

async function cdx(params) {
  const q = new URLSearchParams({ output: 'json', fl: 'original,statuscode,mimetype', collapse: 'urlkey', limit: '5000', ...params });
  const t0 = Date.now();
  try {
    const res = await fetch(`https://web.archive.org/cdx/search/cdx?${q}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return `HTTP ${res.status}`;
    const rows = JSON.parse((await res.text()) || '[]').slice(1);
    const by = (k) =>
      Object.entries(rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {}))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([v, n]) => `${v}:${n}`)
        .join(' ');
    return `${rows.length} rows in ${Date.now() - t0}ms · status ${by(1)} · mime ${by(2)} · e.g. ${rows
      .slice(0, 3)
      .map((r) => r[0])
      .join(' ')}`;
  } catch (e) {
    return `failed after ${Date.now() - t0}ms: ${e.message}`;
  }
}

for (const d of process.argv.slice(2)) {
  console.log(`\n### ${d}`);
  console.log(`- cdx ${d}/*: ${await cdx({ url: `${d}/*` })}`);
  console.log(`- cdx ${d} (exact): ${await cdx({ url: d })}`);
  console.log(`- cdx www.${d}/*: ${await cdx({ url: `www.${d}/*` })}`);
  console.log(`- cdx *.${d}: ${await cdx({ url: d, matchType: 'domain' })}`);
  try {
    const s = await sitemapUrls(d, { timeoutMs: 20000 });
    console.log(
      `- sitemaps: ${s.length} URLs, e.g. ${s
        .slice(0, 3)
        .map((u) => u.path)
        .join(' ')}`,
    );
  } catch (e) {
    console.log(`- sitemaps failed: ${e.message}`);
  }
  try {
    const t0 = Date.now();
    const s = await scanDomain(d, { max: 200, concurrency: 16, limit: 10000, timeoutMs: 30000, checkTimeoutMs: 10000 });
    console.log(
      `- scan (${((Date.now() - t0) / 1000).toFixed(0)}s): published ${s.published}, sitemapOnly ${s.sitemapOnly ?? 0}, checked ${s.checked}, ${JSON.stringify(s.counts)}, sources ${JSON.stringify(s.sources)}${s.errors.length ? `, errors: ${s.errors.join('; ')}` : ''}`,
    );
    console.log(renderScanText(s));
    for (const b of s.broken.slice(0, 20))
      console.log(`  - broken ${b.status ?? ''} https://${d}${b.path} (first seen ${b.firstSeen ?? '?'})`);
  } catch (e) {
    console.log(`- scan error: ${e.message}`);
  }
}
