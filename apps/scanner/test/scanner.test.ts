import { describe, expect, it } from 'vitest';
import { handleScan, publicDomain } from '../src/handler.mjs';
import { handleOg, handlePage } from '../src/share.mjs';

describe('scanner', () => {
  it('accepts only public domains', () => {
    expect(publicDomain('https://www.Example.org/path')).toBe('example.org');
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.1', 'intranet', 'db.internal', '[::1]', '', 'a.b'])
      expect(publicDomain(bad), bad).toBeUndefined();
  });

  it('rejects a bad domain with 400', async () => {
    const r = await handleScan(new Request('https://scan.test/api/scan?d=localhost'));
    expect(r.status).toBe(400);
  });

  it('streams progress, then the summary', async () => {
    const fake = (async (input: any) => {
      const u = new URL(String(input));
      if (u.host === 'web.archive.org')
        return new Response(
          JSON.stringify(
            u.searchParams.getAll('filter').some((x) => x.startsWith('original:'))
              ? []
              : [
                  ['original', 'timestamp', 'statuscode'],
                  ['https://shop.org/a', '20150101000000', '200'],
                  ['https://shop.org/gone', '20160101000000', '200'],
                ],
          ),
        );
      if (u.pathname === '/sitemap.xml')
        return new Response(
          '<urlset><url><loc>https://shop.org/a</loc></url><url><loc>https://shop.org/never-existed</loc></url></urlset>',
        );
      if (u.pathname === '/a') return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await handleScan(new Request('https://scan.test/api/scan?d=shop.org'), { fetch: fake });
    expect(r.headers.get('content-type')).toContain('ndjson');
    const lines = (await r.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ start: { domain: 'shop.org' } });
    expect(
      lines
        .filter((l) => l.source)
        .map((l) => l.source.name)
        .sort(),
    ).toEqual(['archived-sitemap', 'sitemap', 'wayback']);
    expect(lines.find((l) => l.history).history).toEqual({ published: 2, checking: 2 });
    const last = lines.at(-1);
    expect(last.done.counts).toMatchObject({ ok: 1, broken: 1 });
    expect(last.done.sitemapOnly).toBe(1);
    expect(last.headline).toContain('shop.org has published 2 URLs');
  });

  it('fails instead of reporting zero when the Wayback Machine is down, and says why', async () => {
    const down = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    const r = await handleScan(new Request('https://scan.test/api/scan?d=down-shop.org'), { fetch: down });
    const last = (await r.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .at(-1);
    expect(last.error).toMatch(/Wayback Machine is not answering right now \(web.archive.org answered 503\)/);
  }, 20000);

  it('retries a busy Wayback Machine, and falls back to an earlier result', async () => {
    let calls = 0;
    const flaky = (async (input: any) => {
      const u = new URL(String(input));
      if (u.host !== 'web.archive.org') return new Response('', { status: 404 });
      if (calls++ === 0) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(
        JSON.stringify([
          ['original', 'timestamp'],
          ['https://flaky.org/a', '20200101000000'],
        ]),
      );
    }) as typeof fetch;
    const ok = (await (await handleScan(new Request('https://scan.test/api/scan?d=flaky.org'), { fetch: flaky })).text())
      .trim()
      .split('\n');
    expect(JSON.parse(ok.at(-1)!).done.published).toBe(1);

    // shop.org was scanned above: a failing fresh scan shows that result, with the reason
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    const r = await handleScan(new Request('https://scan.test/api/scan?d=shop.org&fresh=1'), { fetch: down, ip: '198.51.100.7' });
    const last = JSON.parse((await r.text()).trim().split('\n').at(-1)!);
    expect(last.stored).toBe(true);
    expect(last.done.domain).toBe('shop.org');
    expect(last.notice).toMatch(/not answering right now/);
  }, 20000);

  it('answers a recent result at once, and limits fresh scans per client', async () => {
    const r = await handleScan(new Request('https://scan.test/api/scan?d=shop.org'));
    const lines = (await r.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].done.domain).toBe('shop.org');
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const x = await handleScan(
        new Request('https://scan.test/api/scan?d=bad.invalid-tld-zz&fresh=1'.replace('bad.invalid-tld-zz', `x${i}.org`)),
        {
          ip: '203.0.113.9',
          fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
        },
      );
      codes.push(x.status);
      await x.body?.cancel();
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('serves a page and a preview image per domain', async () => {
    const page = await (await handlePage(new Request('https://scan.test/d/shop.org'))).text();
    expect(page).toContain('<title>shop.org has published 2 URLs');
    expect(page).toContain('/api/og?d=shop.org');
    expect(page).toContain('window.PERMALOCK_DOMAIN="shop.org"');
    const img = await handleOg(new Request('https://scan.test/api/og?d=shop.org'));
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(5000);
  });
});
