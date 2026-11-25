import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLockfile, resolve, serializeLockfile } from '../src/index.js';

const root = path.resolve(__dirname, '../../../spec/conformance');

describe('conformance: resolve', () => {
  const dir = path.join(root, 'resolve');
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const c = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    it(`${f}: ${c.description}`, () => {
      const r = resolve({
        lock: parseLockfile(JSON.stringify(c.lock)),
        pages: c.build,
        knownRedirects: c.knownRedirects ? new Map(Object.entries(c.knownRedirects)) : undefined,
        options: c.options,
      });
      expect(serializeLockfile(r.lock)).toBe(serializeLockfile(parseLockfile(JSON.stringify(c.expect.lock))));
      expect(r.orphans.map((o) => o.url).sort()).toEqual([...c.expect.orphans].sort());
      for (const [url, to] of Object.entries(c.expect.suggestions ?? {}))
        expect(r.orphans.find((o) => o.url === url)?.suggestion?.to).toBe(to);
      expect(r.errors.map((e) => `${e.url} ${e.kind}`).sort()).toEqual(c.expect.errors.map((e: any) => `${e.url} ${e.kind}`).sort());
    });
  }
});

describe('conformance: serialize', () => {
  const dir = path.join(root, 'serialize');
  for (const d of readdirSync(dir).sort()) {
    it(d, () => {
      const input = readFileSync(path.join(dir, d, 'input.json'), 'utf8');
      const expected = readFileSync(path.join(dir, d, 'expected.json'), 'utf8');
      expect(serializeLockfile(parseLockfile(input))).toBe(expected);
      // idempotent
      expect(serializeLockfile(parseLockfile(expected))).toBe(expected);
    });
  }
});
