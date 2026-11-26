// End-to-end checks against real sites. Needs network: runs in GitHub Actions.
// node apps/scanner/e2e/run.mjs http://localhost:8787
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8787';
const results = [];

async function scan(domain) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/scan?fresh=1&d=${encodeURIComponent(domain)}`);
  if (res.status !== 200) return { status: res.status, body: await res.json(), ms: Date.now() - t0 };
  const events = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { status: 200, events, last: events.at(-1), ms: Date.now() - t0 };
}

async function check(name, fn) {
  try {
    const note = await fn();
    results.push(`ok    ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    results.push(`FAIL  ${name}: ${e.message}`);
  }
}

function invariants(r) {
  assert.equal(r.status, 200);
  assert.ok(r.events[0].start, 'first event is start');
  assert.ok(r.last.done || r.last.error, 'last event is done or error');
  const kinds = r.events.map((e) => Object.keys(e)[0]);
  if (r.last.done) assert.equal(kinds.filter((k) => k === 'source').length, 3, 'three sources reported');
  if (r.last.done) {
    const s = r.last.done;
    const sum = Object.values(s.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, s.checked, 'counts add up to checked');
    assert.ok(s.checked <= 200, 'at most 200 checks');
    assert.ok(s.checked <= s.published, 'checked <= published');
    assert.equal(s.broken.length, s.counts.broken);
    assert.ok(typeof r.last.headline === 'string' && r.last.headline.includes(s.domain));
  }
  return r.last.done
    ? `${(r.ms / 1000).toFixed(0)}s, ${r.last.done.published} published, ${JSON.stringify(r.last.done.counts)}${r.last.done.errors.length ? `, errors: ${r.last.done.errors.join('; ')}` : ''}`
    : `error: ${r.last.error}`;
}

const scanned = []; // domains whose live scan succeeded, so the server now remembers them
for (const d of ['docs.astro.build', 'biomejs.dev', 'tauri.app', 'en.wikipedia.org', 'https://www.Example.org/some/path?q=1'])
  await check(`real site ${d}`, async () => {
    const r = await scan(d);
    if (r.last.done && !r.last.done.errors.length) scanned.push(r.last.done.domain);
    return invariants(r);
  });

await check('domain that does not exist', async () => {
  const r = await scan('this-domain-does-not-exist-7f3a9c.com');
  const note = invariants(r);
  assert.ok(r.last.done ? r.last.done.published === 0 || r.last.done.counts.error === r.last.done.checked : /Wayback/.test(r.last.error));
  return note;
});

for (const bad of [
  '',
  'localhost',
  '127.0.0.1',
  '10.0.0.1',
  '[::1]',
  'intranet',
  'printer.local',
  'a'.repeat(300) + '.com',
  'exa mple.com',
  '%00',
  'javascript:alert(1)',
])
  await check(`rejects ${JSON.stringify(bad.slice(0, 30))}`, async () => {
    const r = await scan(bad);
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

await check('stored or recent result answers at once', async () => {
  const d = scanned[0];
  if (!d) return console.log('      skipped: no live scan succeeded (the Wayback Machine is down)');
  const t0 = Date.now();
  const res = await fetch(`${base}/api/scan?d=${d}`);
  const last = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .at(-1);
  assert.ok(last.done, 'has a result');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
await check('preview image and page per domain', async () => {
  const img = await fetch(`${base}/api/og?d=docs.astro.build`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const page = await (await fetch(`${base}/d/docs.astro.build`)).text();
  assert.match(page, /og:image" content="[^"]+api\/og\?d=docs.astro.build/);
});

console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
