import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileToUrl, globToRegExp, scanBuild } from '../src/scan.js';
import { article, tmp, writeTree } from './helpers.js';

describe('scan', () => {
  it('maps files to URLs', () => {
    expect(fileToUrl('index.html')).toBe('/');
    expect(fileToUrl(path.join('blog', 'index.html'))).toBe('/blog/');
    expect(fileToUrl('about.html')).toBe('/about');
    expect(fileToUrl('about.html', { htmlExtension: 'keep' })).toBe('/about.html');
    expect(fileToUrl(path.join('caffè', 'index.html'), { base: '/docs/' })).toBe('/docs/caff%C3%A8/');
  });

  it('globs', () => {
    expect(globToRegExp('/drafts/**').test('/drafts/a/b/')).toBe(true);
    expect(globToRegExp('/tags/*/').test('/tags/x/')).toBe(true);
    expect(globToRegExp('/tags/*/').test('/tags/x/y/')).toBe(false);
  });

  it('reads pages, identity, redirects and skips 404 and private folders', async () => {
    const dir = tmp();
    writeTree(dir, {
      'index.html': article('Home'),
      '404.html': article('Not found'),
      '_astro/x.html': 'asset',
      'blog/post/index.html': article('Post', undefined, '<meta name="permalock:id" content="post-1">'),
      'docs/a/index.html': `<main><span hidden data-permalock-source="src/content/docs/a.md"></span>${article('A')}</main>`,
      'old/index.html': '<!doctype html><meta http-equiv="refresh" content="0;url=/blog/post/">',
      'drafts/x/index.html': article('Draft'),
    });
    const r = await scanBuild(dir, { exclude: ['/drafts/**'] });
    expect(r.pages.map((p) => p.url).sort()).toEqual(['/', '/blog/post/', '/docs/a/']);
    expect(r.pages.find((p) => p.url === '/blog/post/')!.source).toBe('id:post-1');
    expect(r.pages.find((p) => p.url === '/docs/a/')!.source).toBe('src/content/docs/a.md');
    expect(r.htmlRedirects.get('/old/')).toBe('/blog/post/');
  });

  it('uses integration-provided sources', async () => {
    const dir = tmp();
    writeTree(dir, { 'about/index.html': article('About') });
    const r = await scanBuild(dir, { sources: new Map([['/about/', 'src/pages/about.astro']]) });
    expect(r.pages[0].source).toBe('src/pages/about.astro');
  });

  it('fails clearly on a missing directory', async () => {
    await expect(scanBuild('/nonexistent/dir')).rejects.toThrow(/Build directory not found/);
  });
});
