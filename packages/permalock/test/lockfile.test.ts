import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockfileError, parseLockfile, readLockfile, serializeLockfile, writeLockfile, type Lockfile } from '../src/index.js';
import { tmp } from './helpers.js';

describe('lockfile', () => {
  it('rejects invalid documents with useful messages', () => {
    expect(() => parseLockfile('{')).toThrow(LockfileError);
    expect(() => parseLockfile('<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x')).toThrow(/conflict markers/);
    expect(() => parseLockfile('{"urls":{}}')).toThrow(/format version/);
    expect(() => parseLockfile('{"permalock":99,"urls":{}}')).toThrow(/Upgrade/);
    expect(() => parseLockfile('{"permalock":1,"urls":{"a":{"type":"page"}}}')).toThrow(/start with/);
    expect(() => parseLockfile('{"permalock":1,"urls":{"/a?x=1":{"type":"page"}}}')).toThrow(/query/);
    expect(() => parseLockfile('{"permalock":1,"urls":{"/a":{"type":"redirect"}}}')).toThrow(/"to"/);
    expect(() => parseLockfile('{"permalock":1,"urls":{"/a":{"type":"moved"}}}')).toThrow(/unknown type/);
  });

  it('writes one line per URL', () => {
    const lock: Lockfile = { permalock: 1, urls: { '/b/': { type: 'page' }, '/a/': { type: 'gone' } } };
    const lines = serializeLockfile(lock).split('\n');
    expect(lines).toEqual(['{', '  "permalock": 1,', '  "urls": {', '    "/a/": { "type": "gone" },', '    "/b/": { "type": "page" }', '  }', '}', '']);
  });

  it('empty urls', () => {
    expect(serializeLockfile({ permalock: 1, urls: {} })).toBe('{\n  "permalock": 1,\n  "urls": {}\n}\n');
  });

  it('shards large sections and reads them back', async () => {
    const dir = tmp();
    const file = path.join(dir, 'permalock.json');
    const lock: Lockfile = { permalock: 1, urls: { '/': { type: 'page' } } };
    for (let i = 0; i < 5; i++) lock.urls[`/docs/p${i}/`] = { type: 'page' };
    lock.urls['/blog/x/'] = { type: 'page' };
    await writeLockfile(file, lock, { shard: 3 });
    expect(readdirSync(dir).sort()).toEqual(['permalock.docs.json', 'permalock.json']);
    expect(readFileSync(path.join(dir, 'permalock.json'), 'utf8')).toContain('/blog/x/');
    const back = await readLockfile(file);
    expect(Object.keys(back!.urls).length).toBe(7);
    // shards are kept on later writes, and removed when no longer needed
    delete lock.urls['/docs/p0/'];
    delete lock.urls['/docs/p1/'];
    delete lock.urls['/docs/p2/'];
    await writeLockfile(file, lock, { shard: 3 });
    expect(readdirSync(dir)).toEqual(['permalock.json']);
  });

  it('refuses a URL present in two shards', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'permalock.json'), '{"permalock":1,"urls":{"/docs/a/":{"type":"page"}}}');
    writeFileSync(path.join(dir, 'permalock.docs.json'), '{"permalock":1,"urls":{"/docs/a/":{"type":"page"}}}');
    await expect(readLockfile(path.join(dir, 'permalock.json'))).rejects.toThrow(/both/);
  });
});
