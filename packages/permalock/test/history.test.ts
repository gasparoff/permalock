import { describe, expect, it } from 'vitest';
import { collectHistory, parseSitemap, summarizeScan, renderScanText, renderScanHtml, toSitePath, checkLive } from '../src/index.js';

function fakeFetch(map: Record<string, { status?: number; body: string } | ((u: URL) => { status?: number; body: string })>) {
  const calls: string[] = [];
  const f = (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.href);
    const key = Object.keys(map).find((k) => u.href.startsWith(k));
    if (!key) return new Response('nope', { status: 404 });
    const v = typeof map[key] === 'function' ? (map[key] as any)(u) : map[key];
    return new Response(v.body, { status: v.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe('history', () => {
  it('normalises historic URLs', () => {
    expect(toSitePath('http://www.example.com/blog/a/?utm=1', 'example.com')).toBe('/blog/a/');
    expect(toSitePath('https://example.com/style.css', 'example.com')).toBeUndefined();
    expect(toSitePath('https://other.com/a', 'example.com')).toBeUndefined();
    expect(toSitePath('https://example.com/wp-admin/x', 'example.com')).toBeUndefined();
    expect(toSitePath('https://example.com:443//a//b', 'example.com')).toBe('/a/b');
    expect(toSitePath('https://example.com/caffè', 'example.com')).toBe('/caff%C3%A8');
  });

  it('parses sitemaps and indexes', () => {
    expect(
      parseSitemap('<urlset><url><loc>https://e.com/a</loc></url><url><loc><![CDATA[https://e.com/b?x=1&amp;y=2]]></loc></url></urlset>')
        .urls,
    ).toEqual(['https://e.com/a', 'https://e.com/b?x=1&y=2']);
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>').sitemaps).toEqual([
      'https://e.com/s1.xml',
    ]);
  });

  it('collects from Wayback (with pagination), archived and current sitemaps', async () => {
    const { f } = fakeFetch({
      'https://web.archive.org/cdx/search/cdx': (u) => {
        if (u.searchParams.getAll('filter').some((x) => x.startsWith('original:')))
          return {
            body: JSON.stringify([
              ['original', 'timestamp'],
              ['https://example.com/sitemap.xml', '20150101000000'],
            ]),
          };
        if (u.searchParams.get('resumeKey'))
          return {
            body: JSON.stringify([
              ['original', 'timestamp'],
              ['https://example.com/page-3', '20180101000000'],
            ]),
          };
        return {
          body: JSON.stringify([
            ['original', 'timestamp'],
            ['http://example.com/', '20140301000000'],
            ['http://www.example.com/page-1', '20160101000000'],
            ['http://example.com/logo.png', '20160101000000'],
            [],
            ['resume-key-1'],
          ]),
        };
      },
      'https://web.archive.org/web/20150101000000id_/https://example.com/sitemap.xml': {
        body: '<urlset><url><loc>https://example.com/old-archive-only</loc></url></urlset>',
      },
      'https://example.com/robots.txt': { body: 'User-agent: *\nSitemap: https://example.com/sitemap-index.xml\n' },
      'https://example.com/sitemap-index.xml': {
        body: '<sitemapindex><sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap></sitemapindex>',
      },
      'https://example.com/sitemap-0.xml': {
        body: '<urlset><url><loc>https://example.com/page-1</loc></url><url><loc>https://example.com/new</loc></url></urlset>',
      },
    });
    const h = await collectHistory('https://www.example.com', { fetch: f });
    expect(h.domain).toBe('example.com');
    expect(h.urls.map((u) => u.path)).toEqual(['/', '/new', '/old-archive-only', '/page-1', '/page-3']);
    expect(h.firstSeen).toBe('2014-03-01');
    expect(h.sources).toEqual({ wayback: 3, 'archived-sitemap': 1, sitemap: 2 });
    expect(h.errors).toEqual([]);
  });

  it('reports source errors without failing', async () => {
    const { f } = fakeFetch({ 'https://web.archive.org/cdx/search/cdx': { status: 503, body: '' } });
    const h = await collectHistory('example.com', { fetch: f });
    expect(h.errors.join()).toMatch(/Wayback/);
  });

  it('classifies live behaviour and renders the report', async () => {
    const routes: Record<string, { status: number; location?: string }> = {
      '/': { status: 200 },
      '/new': { status: 200 },
      '/a': { status: 301, location: '/new' },
      '/b': { status: 301, location: '/a' },
      '/c': { status: 404 },
      '/d': { status: 500 },
    };
    const f = (async (input: any) => {
      const u = new URL(String(input));
      const r = routes[u.pathname] ?? { status: 404 };
      return new Response(null, { status: r.status, headers: r.location ? { location: r.location } : {} });
    }) as typeof fetch;
    const live = await checkLive('example.com', ['/', '/a', '/b', '/c', '/d'], { fetch: f });
    expect(live.map((l) => l.state)).toEqual(['ok', 'redirect', 'chain', 'broken', 'error']);
    const s = summarizeScan(
      {
        domain: 'example.com',
        urls: [{ path: '/c', origin: 'wayback', firstSeen: '2015-01-01' }],
        sources: { wayback: 5 },
        errors: [],
        firstSeen: '2014-01-01',
      },
      live,
      5,
    );
    expect(renderScanText(s)).toContain('example.com has published 5 URLs since 2014. 1 of them is broken today.');
    expect(renderScanHtml(s)).toContain('<td>2015-01-01</td>');
  });
});
