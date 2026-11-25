// Browser checks of the scanner page, desktop and phone: a real scan, then a fixed result for the layout.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:8787';
const fixture = {
  domain: 'fixture.org',
  scannedAt: '2026-11-24T10:00:00Z',
  published: 1313,
  checked: 200,
  firstSeen: '2021-03-02',
  sources: { wayback: 1313, sitemap: 1200, 'archived-sitemap': 900 },
  errors: [],
  counts: { ok: 120, redirect: 52, chain: 8, broken: 20, error: 0 },
  broken: Array.from({ length: 20 }, (_, i) => ({ path: `/en/guides/a-rather-long-page-name-that-could-overflow-${i}/`, status: 404 })),
  chains: [{ path: '/old/', hops: 2, final: '/new/' }],
};
const b = await chromium.launch();
let failed = false;
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
]) {
  const page = await b.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // a failed scan logs nothing on purpose; anything else in the console is a bug
  page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d/.test(m.text()) && errors.push(m.text()));

  // 1. a real scan ends with a report or a clear error, never hangs
  await page.goto(`${base}/d/docs.astro.build`);
  await page.waitForSelector('#report:not([hidden]), #run-err:not([hidden])', { timeout: 280000 });
  const real = (await page.isVisible('#report'))
    ? `report: ${await page.textContent('#headline')}`
    : `error: ${await page.textContent('#run-err-text')}`;

  // 2. a fixed result, so the layout is checked even when the Wayback Machine is down
  await page.route('**/api/scan*', (r) =>
    r.fulfill({
      contentType: 'application/x-ndjson',
      body: [{ start: { domain: 'fixture.org' } }, { done: fixture, headline: 'fixture.org has published 1,313 URLs.', stored: true }]
        .map((l) => JSON.stringify(l) + '\n')
        .join(''),
    }),
  );
  await page.goto(`${base}/d/fixture.org`);
  await page.waitForSelector('#report:not([hidden])', { timeout: 10000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const rows = await page.$$eval('.list .row', (r) => r.length);
  await page.screenshot({ path: `scanner-${name}.png`, fullPage: true });

  // a bad input is refused in place
  await page.fill('#domain', 'nope');
  await page.click('#go');
  const hint = await page.textContent('#hint');
  const ok = !errors.length && !overflow && rows > 0 && hint.includes('public domain');
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}: real scan ${real} | fixture rows=${rows} overflow=${overflow} errors=${errors.join(' | ') || 'none'}`,
  );
  failed ||= !ok;
}
await b.close();
process.exit(failed ? 1 : 0);
