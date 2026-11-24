import { afterAll, describe, expect, it } from 'vitest';
import { verify, type Lockfile } from '../src/index.js';
import { serve } from './server.js';

describe('verify', async () => {
  const s = await serve({
    '/': { status: 200 },
    '/ok/': { status: 200 },
    '/moved/': { status: 301, location: '/ok/' },
    '/moved-308/': { status: 308, location: '/ok/' },
    '/temp/': { status: 302, location: '/ok/' },
    '/two-hops': { status: 301, location: '/two-hops/' },
    '/two-hops/': { status: 301, location: '/ok/' },
    '/soft/': { status: 200, body: '<meta http-equiv="refresh" content="0;url=/ok/">' },
    '/no-slash': { status: 301, location: '/no-slash/' },
    '/gone410/': { status: 410 },
    '/to-broken/': { status: 301, location: '/broken/' },
    '/still-here/': { status: 200 },
  });
  afterAll(() => s.close());

  const lock: Lockfile = {
    permalock: 1,
    urls: {
      '/': { type: 'page' },
      '/ok/': { type: 'page' },
      '/missing/': { type: 'page' },
      '/no-slash': { type: 'page' },
      '/moved/': { type: 'redirect', to: '/ok/' },
      '/moved-308/': { type: 'redirect', to: '/ok/' },
      '/temp/': { type: 'redirect', to: '/ok/' },
      '/two-hops': { type: 'redirect', to: '/ok/' },
      '/soft/': { type: 'redirect', to: '/ok/' },
      '/to-broken/': { type: 'redirect', to: '/broken/' },
      '/gone410/': { type: 'gone' },
      '/gone404/': { type: 'gone' },
      '/still-here/': { type: 'gone' },
    },
  };

  it('checks the invariant for every entry', async () => {
    const r = await verify(lock, { against: s.origin, concurrency: 4 });
    const by = Object.fromEntries(r.items.map((i) => [i.url, i]));
    expect(by['/'].status).toBe('pass');
    expect(by['/ok/'].status).toBe('pass');
    expect(by['/missing/'].status).toBe('fail');
    expect(by['/no-slash'].status).toBe('fail');
    expect(by['/no-slash'].hint).toMatch(/trailing-slash/);
    expect(by['/moved/'].status).toBe('pass');
    expect(by['/moved-308/'].status).toBe('pass');
    expect(by['/temp/'].status).toBe('fail');
    expect(by['/temp/'].hint).toMatch(/Temporary/);
    expect(by['/two-hops'].status).toBe('fail');
    expect(by['/two-hops'].hint).toMatch(/Two hops/);
    expect(by['/soft/'].status).toBe('soft');
    expect(by['/to-broken/'].status).toBe('fail');
    expect(by['/gone410/'].status).toBe('pass');
    expect(by['/gone404/'].status).toBe('pass');
    expect(by['/still-here/'].status).toBe('fail');
    expect(r.counts).toEqual({ pass: 6, fail: 6, soft: 1, error: 0 });
  });

  it('falls back to GET when HEAD is refused', async () => {
    const t = await serve({ '/': { status: 200 } }, { noHead: true });
    const r = await verify({ permalock: 1, urls: { '/': { type: 'page' } } }, { against: t.origin });
    expect(r.counts.pass).toBe(1);
    expect(t.hits).toEqual(['HEAD /', 'GET /']);
    await t.close();
  });

  it('samples', async () => {
    const r = await verify(lock, { against: s.origin, sample: 3 });
    expect(r.items.length).toBe(3);
  });

  it('needs an origin', async () => {
    await expect(verify({ permalock: 1, urls: {} })).rejects.toThrow(/--against/);
  });
});
