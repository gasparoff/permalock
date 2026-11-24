import { describe, expect, it } from 'vitest';
import { fingerprint, fnv1a64, metaContent, metaRefreshTarget, normalizedText, simhash, simSimilarity, words } from '../src/text.js';
import { article, TEXT } from './helpers.js';

const hex = ([h, l]: [number, number]) => h.toString(16).padStart(8, '0') + l.toString(16).padStart(8, '0');

describe('text', () => {
  it('FNV-1a 64 matches reference vectors', () => {
    expect(hex(fnv1a64(''))).toBe('cbf29ce484222325');
    expect(hex(fnv1a64('a'))).toBe('af63dc4c8601ec8c');
    expect(hex(fnv1a64('foobar'))).toBe('85944171f73967e8');
  });

  it('extracts main text without chrome, scripts and entities', () => {
    const t = normalizedText(article('Hello &amp; welcome', 'Caf&eacute; &#8212; ok'));
    expect(t).toBe('hello & welcome café — ok');
  });

  it('falls back to article, then body', () => {
    expect(normalizedText('<body><nav>x</nav><article><p>A</p></article><p>B</p></body>')).toBe('a');
    expect(normalizedText('<body><nav>x</nav><p>B</p></body>')).toBe('b');
  });

  it('handles nested main/article', () => {
    expect(normalizedText('<body><article>a <article>b</article> c</article> d</body>')).toBe('a b c');
  });

  it('omits hash and sim for short pages', () => {
    const fp = fingerprint(article('Tiny', 'just a few words'));
    expect(fp.hash).toBeUndefined();
    expect(fp.sim).toBeUndefined();
    const long = fingerprint(article('Long'));
    expect(long.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(long.sim).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same content, different chrome: same hash', () => {
    const a = fingerprint(article('T'));
    const b = fingerprint(article('T').replace('© 2026 Example', 'Changed footer').replace('<title>T</title>', '<title>Other</title>'));
    expect(a.hash).toBe(b.hash);
  });

  it('simhash: a light edit stays above 0.85, different texts stay far apart', () => {
    const base = simhash(words(normalizedText(article('T', TEXT.a))));
    const edited = simhash(words(normalizedText(article('T', TEXT.a.replace('in a forum', 'on a forum').replace('The lockfile remembers.', 'The lockfile remembers them all.')))));
    const other = simhash(words(normalizedText(article('T', TEXT.c))));
    expect(simSimilarity(base, edited)).toBeGreaterThan(0.85);
    expect(simSimilarity(base, other)).toBeLessThan(0.75);
  });

  it('reads meta refresh and named metas', () => {
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="0;url=/new/">')).toBe('/new/');
    expect(metaRefreshTarget(`<meta content='0; URL=https://x.com/a' http-equiv='refresh'>`)).toBe('https://x.com/a');
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="30">')).toBeUndefined();
    expect(metaContent('<meta name="permalock:id" content="intro">', 'permalock:id')).toBe('intro');
  });
});
