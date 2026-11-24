import { describe, expect, it } from 'vitest';
import { addRedirect, DecisionError, forget, mergeLockfiles, retire, toUrlKey, type Lockfile } from '../src/index.js';

const L = (urls: Lockfile['urls'], site?: string): Lockfile => ({ permalock: 1, ...(site ? { site } : {}), urls });

describe('decisions', () => {
  it('normalises input URLs', () => {
    expect(toUrlKey('blog/a')).toBe('/blog/a');
    expect(toUrlKey('https://www.example.com/a/', 'https://example.com')).toBe('/a/');
    expect(toUrlKey('https://other.com/a/', 'https://example.com')).toBe('https://other.com/a/');
    expect(toUrlKey('/caffè/')).toBe('/caff%C3%A8/');
    expect(toUrlKey('/caff%C3%A8/')).toBe('/caff%C3%A8/');
  });

  it('records redirects and collapses chains', () => {
    const lock = L({ '/a/': { type: 'redirect', to: '/b/' }, '/b/': { type: 'page' }, '/c/': { type: 'page' } });
    addRedirect(lock, '/b/', '/c/');
    expect(lock.urls['/a/']).toEqual({ type: 'redirect', to: '/c/' });
    expect(lock.urls['/b/']).toEqual({ type: 'redirect', to: '/c/', reason: 'manual' });
  });

  it('refuses self redirects, foreign sources and plain http targets', () => {
    const lock = L({}, 'https://example.com');
    expect(() => addRedirect(lock, '/a/', '/a/')).toThrow(DecisionError);
    expect(() => addRedirect(lock, 'https://other.com/a', '/b/')).toThrow(/not on this site/);
    expect(() => addRedirect(lock, '/a/', 'http://other.com/')).toThrow(/https/);
    addRedirect(lock, '/a/', 'https://other.com/');
    expect(lock.urls['/a/']).toMatchObject({ to: 'https://other.com/' });
  });

  it('retire reports redirects that pointed there', () => {
    const lock = L({ '/a/': { type: 'redirect', to: '/b/' }, '/b/': { type: 'page' } });
    expect(retire(lock, '/b/', 'gone for good')).toEqual(['/a/']);
    expect(lock.urls['/b/']).toEqual({ type: 'gone', reason: 'gone for good' });
  });

  it('forget', () => {
    const lock = L({ '/a/': { type: 'page' } });
    expect(forget(lock, '/a/')).toBe(true);
    expect(forget(lock, '/a/')).toBe(false);
  });
});

describe('merge', () => {
  const base = L({ '/': { type: 'page' }, '/x/': { type: 'page', hash: '1' } });
  it('unions independent additions', () => {
    const ours = L({ ...base.urls, '/a/': { type: 'page' } });
    const theirs = L({ ...base.urls, '/b/': { type: 'page' } });
    const r = mergeLockfiles(base, ours, theirs);
    expect(Object.keys(r.lock.urls).sort()).toEqual(['/', '/a/', '/b/', '/x/']);
    expect(r.conflicts).toEqual([]);
  });
  it('takes the side that changed', () => {
    const ours = L({ ...base.urls });
    const theirs = L({ ...base.urls, '/x/': { type: 'redirect', to: '/' } });
    expect(mergeLockfiles(base, ours, theirs).lock.urls['/x/']).toEqual({ type: 'redirect', to: '/' });
    const deleted = L({ '/': { type: 'page' } });
    expect(mergeLockfiles(base, ours, deleted).lock.urls['/x/']).toBeUndefined();
  });
  it('same type both sides: ours wins quietly', () => {
    const ours = L({ ...base.urls, '/x/': { type: 'page', hash: '2' } });
    const theirs = L({ ...base.urls, '/x/': { type: 'page', hash: '3' } });
    const r = mergeLockfiles(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.lock.urls['/x/']).toEqual({ type: 'page', hash: '2' });
  });
  it('different decisions conflict', () => {
    const ours = L({ ...base.urls, '/x/': { type: 'gone' } });
    const theirs = L({ ...base.urls, '/x/': { type: 'redirect', to: '/' } });
    expect(mergeLockfiles(base, ours, theirs).conflicts.map((c) => c.url)).toEqual(['/x/']);
  });
});
