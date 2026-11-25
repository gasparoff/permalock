import { describe, expect, it } from 'vitest';
import { applyAnswer, importHistory } from '../src/importer.js';
import type { Lockfile } from '../src/types.js';

// A site with a Wayback history and a live server, all in memory.
function site(history: string[], live: Record<string, { status: number; location?: string }>) {
  return (async (input: any) => {
    const u = new URL(String(input));
    if (u.host === 'web.archive.org') {
      // only the page query answers; archived sitemaps are empty
      if (u.searchParams.has('collapse', 'digest')) return new Response('[]');
      return new Response(JSON.stringify([['original', 'timestamp'], ...history.map((p) => [`https://shop.test${p}`, '20200101000000'])]));
    }
    const r = live[u.pathname] ?? { status: 404 };
    return new Response(null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;
}

const lockWith = (...pages: string[]): Lockfile => ({
  permalock: 1,
  site: 'https://shop.test',
  urls: Object.fromEntries(pages.map((p) => [p, { type: 'page' as const }])),
});

describe('import', () => {
  it('adds historic URLs the lockfile does not know, under the base only', async () => {
    const lock = lockWith('/docs/', '/docs/a/');
    const r = await importHistory(lock, 'shop.test', { fetch: site(['/docs/a', '/docs/old/', '/blog/x/', '/docsy/'], {}), base: '/docs' });
    expect(r.added.map((u) => u.path)).toEqual(['/docs/old/']);
    expect(lock.urls['/docs/old/']).toEqual({ type: 'page', origin: 'wayback' });
    expect(lock.urls['/blog/x/']).toBeUndefined();
  });

  it('--check-live adopts real redirects, skips pages still served, and never adopts a redirect to the home page', async () => {
    const lock = lockWith('/', '/new/');
    const r = await importHistory(lock, 'shop.test', {
      checkLive: true,
      fetch: site(['/moved/', '/hop/', '/kept/', '/to-home/', '/gone/'], {
        '/': { status: 200 },
        '/new/': { status: 200 },
        '/moved/': { status: 301, location: 'https://shop.test/new/' },
        '/hop/': { status: 301, location: '/moved/' },
        '/kept/': { status: 200 },
        '/to-home/': { status: 301, location: '/' },
      }),
    });
    expect(r.adopted).toEqual([
      { from: '/hop/', to: '/new/' },
      { from: '/moved/', to: '/new/' },
    ]);
    expect(lock.urls['/moved/']).toEqual({ type: 'redirect', to: '/new/', reason: 'adopted from live site' });
    expect(r.servedElsewhere).toEqual(['/kept/']);
    expect(r.added.map((u) => u.path)).toEqual(['/gone/', '/to-home/']);
  });
});

describe('resolve answers', () => {
  const orphan = { url: '/old/' };
  it('redirects to a numbered option, a typed path or an absolute URL', () => {
    const lock = lockWith('/a/', '/b/', '/old/');
    expect(applyAnswer(lock, orphan, ['/a/', '/b/'], '2')).toBe(true);
    expect(lock.urls['/old/']).toMatchObject({ type: 'redirect', to: '/b/' });
    expect(applyAnswer(lock, orphan, [], '/a/')).toBe(true);
    expect(lock.urls['/old/']).toMatchObject({ to: '/a/' });
    expect(applyAnswer(lock, orphan, [], 'https://elsewhere.test/x')).toBe(true);
    expect(lock.urls['/old/']).toMatchObject({ to: 'https://elsewhere.test/x' });
  });

  it('retires with a reason, and refuses what it does not understand', () => {
    const lock = lockWith('/old/');
    expect(applyAnswer(lock, orphan, ['/a/'], '7')).toBe(false);
    expect(applyAnswer(lock, orphan, [], 'maybe')).toBe(false);
    expect(lock.urls['/old/']).toEqual({ type: 'page' });
    expect(applyAnswer(lock, orphan, [], 'g', 'campaign ended')).toBe(true);
    expect(lock.urls['/old/']).toEqual({ type: 'gone', reason: 'campaign ended' });
  });
});
