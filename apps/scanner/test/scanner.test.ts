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

  it('asks the Wayback Machine by domain when the prefix query fails', async () => {
    const f = (async (input: any) => {
      const u = new URL(String(input));
      if (u.host !== 'web.archive.org') return new Response('', { status: 404 });
      if (u.searchParams.get('url')!.endsWith('/*')) return new Response('', { status: 400 });
      return new Response(
        JSON.stringify([
          ['original', 'timestamp'],
          ['https://www.prefix.org/p', '20200101000000'],
        ]),
      );
    }) as typeof fetch;
    const lines = (await (await handleScan(new Request('https://scan.test/api/scan?d=prefix.org'), { fetch: f })).text())
      .trim()
      .split('\n');
    expect(JSON.parse(lines.at(-1)!).done.published).toBe(1);
  });

  it('explains a site the archive leaves out, and never trusts an empty fallback', async () => {
    const last = async (d: string, f: typeof fetch) =>
      JSON.parse(
        (await (await handleScan(new Request(`https://scan.test/api/scan?d=${d}`), { fetch: f })).text()).trim().split('\n').at(-1)!,
      );
    const excluded = (async (input: any) =>
      new Response('', { status: new URL(String(input)).host === 'web.archive.org' ? 403 : 404 })) as typeof fetch;
    expect((await last('excluded.org', excluded)).error).toMatch(/does not share the history of excluded.org/);
    const empty = (async (input: any) => {
      const u = new URL(String(input));
      if (u.host !== 'web.archive.org') return new Response('', { status: 404 });
      return u.searchParams.get('url')!.endsWith('/*') ? new Response('', { status: 400 }) : new Response('');
    }) as typeof fetch;
    expect((await last('empty.org', empty)).error).toMatch(/not answering right now \(web.archive.org answered 400\)/);
  });

  it('counts redirects to the home page as broken, and says when a site refuses the checks', async () => {
    const rows = [['original', 'timestamp'], ...Array.from({ length: 12 }, (_, i) => [`https://home.org/post-${i}`, '20200101000000'])];
    const site = (status: number) =>
      (async (input: any, init?: any) => {
        const u = new URL(String(input));
        if (u.host === 'web.archive.org')
          return new Response(
            u.searchParams.get('url')?.endsWith('/*') && !u.searchParams.has('collapse', 'digest') ? JSON.stringify(rows) : '[]',
          );
        if (u.pathname === '/') return new Response('', { status: 200 });
        if (u.pathname.endsWith('.xml') || u.pathname.endsWith('.txt')) return new Response('', { status: 404 });
        return new Response('', status === 301 ? { status, headers: { location: 'https://home.org/' } } : { status });
      }) as typeof fetch;
    const last = async (d: string, f: typeof fetch) =>
      JSON.parse(
        (await (await handleScan(new Request(`https://scan.test/api/scan?d=${d}`), { fetch: f })).text()).trim().split('\n').at(-1)!,
      );
    const home = await last('home.org', site(301));
    expect(home.done.counts.broken).toBe(12);
    expect(home.done.broken[0].to).toBe('/');
    expect(home.done.broken.some((b: any) => b.path === '/')).toBe(false);
    const blocked = await last('home.org&fresh=1', site(403));
    expect(blocked.headline).toMatch(/refused most of our checks/);
  });

  it('skips listing pages and AMP copies, and asks again by domain when the prefix answer is empty', async () => {
    let byDomain = 0;
    const f = (async (input: any) => {
      const u = new URL(String(input));
      if (u.host !== 'web.archive.org') return new Response('', { status: 404 });
      if (u.searchParams.get('url')!.endsWith('/*')) return new Response('');
      byDomain++;
      return new Response(
        JSON.stringify([
          ['original', 'timestamp'],
          ['https://quiet.org/a', '2020'],
          ['https://quiet.org/page/2/', '2020'],
          ['https://quiet.org/a/amp/', '2020'],
        ]),
      );
    }) as typeof fetch;
    const lines = (await (await handleScan(new Request('https://scan.test/api/scan?d=quiet.org'), { fetch: f })).text()).trim().split('\n');
    expect(byDomain).toBe(1);
    expect(JSON.parse(lines.at(-1)!).done.published).toBe(1);
  });

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
