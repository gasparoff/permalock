// Browser checks of the scanner page against a real scan, desktop and phone.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:8787';
const b = await chromium.launch();
let failed = false;
for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await b.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/d/docs.astro.build`);
  await page.waitForSelector('#report:not([hidden])', { timeout: 280000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const headline = await page.textContent('#headline');
  const rows = await page.$$eval('.list .row', (r) => r.length);
  await page.screenshot({ path: `scanner-${name}.png`, fullPage: true });
  // a second scan replaces the first cleanly
  await page.fill('#domain', 'nope');
  await page.click('#go');
  const hint = await page.textContent('#hint');
  const ok = !errors.length && !overflow && headline && hint.includes('public domain');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: "${headline}" rows=${rows} overflow=${overflow} errors=${errors.join(' | ') || 'none'}`);
  failed ||= !ok;
}
await b.close();
process.exit(failed ? 1 : 0);
