import { describe, expect, it } from 'vitest';
import { handleScan, publicDomain } from '../src/handler.mjs';

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
        return new Response(JSON.stringify(u.searchParams.getAll('filter').some((x) => x.startsWith('original:')) ? [] : [
          ['original', 'timestamp', 'statuscode'],
          ['https://shop.org/a', '20150101000000', '200'],
          ['https://shop.org/gone', '20160101000000', '200'],
        ]));
      if (u.pathname === '/a') return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await handleScan(new Request('https://scan.test/api/scan?d=shop.org'), { fetch: fake });
    expect(r.headers.get('content-type')).toContain('ndjson');
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].step).toContain('shop.org');
    const last = lines.at(-1);
    expect(last.done.counts).toMatchObject({ ok: 1, broken: 1 });
    expect(last.headline).toContain('shop.org has published 2 URLs');
  });
});
