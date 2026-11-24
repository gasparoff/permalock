import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emit, htmlFileFor, writeEmitted, type Lockfile } from '../src/index.js';
import { tmp, writeTree } from './helpers.js';

const lock: Lockfile = {
  permalock: 1,
  site: 'https://example.com',
  urls: {
    '/': { type: 'page' },
    '/new/': { type: 'page' },
    '/old/': { type: 'redirect', to: '/new/' },
    '/old-file': { type: 'redirect', to: '/new/' },
    '/promo/': { type: 'gone' },
  },
};

describe('emit', () => {
  it('netlify _redirects with 410, merged into an existing file', async () => {
    const dir = tmp();
    writeTree(dir, { _redirects: '/*  /index.html  200\n' });
    const r = emit(lock, 'netlify', { out: dir });
    await writeEmitted(r);
    const text = readFileSync(path.join(dir, '_redirects'), 'utf8');
    expect(text.indexOf('/old/ /new/ 301')).toBeLessThan(text.indexOf('/*  /index.html'));
    expect(text).toContain('/promo/ /404.html 410!');
    // idempotent
    await writeEmitted(emit(lock, 'netlify', { out: dir }));
    expect(readFileSync(path.join(dir, '_redirects'), 'utf8')).toBe(text);
  });

  it('cloudflare warns about 410', () => {
    const r = emit(lock, 'cloudflare', { out: '/x' });
    expect(r.files[0].content).not.toContain('410');
    expect(r.warnings.join()).toMatch(/410/);
  });

  it('vercel merges into vercel.json', async () => {
    const dir = tmp();
    writeTree(dir, { 'vercel.json': JSON.stringify({ cleanUrls: true, redirects: [{ source: '/keep', destination: '/' }] }) });
    await writeEmitted(emit(lock, 'vercel', { out: dir }));
    const cfg = JSON.parse(readFileSync(path.join(dir, 'vercel.json'), 'utf8'));
    expect(cfg.cleanUrls).toBe(true);
    expect(cfg.redirects).toContainEqual({ source: '/old/', destination: '/new/', statusCode: 301 });
    expect(cfg.redirects).toContainEqual({ source: '/keep', destination: '/' });
  });

  it('html pages never overwrite real pages', async () => {
    const dir = tmp();
    writeTree(dir, { 'old/index.html': 'REAL' });
    const res = await writeEmitted(emit(lock, 'html', { out: dir }));
    expect(readFileSync(path.join(dir, 'old/index.html'), 'utf8')).toBe('REAL');
    expect(res.skipped.length).toBe(1);
    expect(existsSync(path.join(dir, 'old-file.html'))).toBe(true);
    expect(readFileSync(path.join(dir, 'old-file.html'), 'utf8')).toContain('url=/new/');
  });

  it('html file mapping', () => {
    expect(htmlFileFor('/a/b/')).toBe(path.join('a', 'b', 'index.html'));
    expect(htmlFileFor('/a/b')).toBe(path.join('a', 'b.html'));
    expect(htmlFileFor('/docs/a/', '/docs')).toBe(path.join('a', 'index.html'));
  });

  it('nginx and apache', () => {
    expect(emit(lock, 'nginx', { out: '/x' }).files[0].content).toContain('location = /promo/ { return 410; }');
    expect(emit(lock, 'apache', { out: '/x' }).files[0].content).toContain('Redirect gone /promo/');
  });
});
