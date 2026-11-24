import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as devalueParse } from 'devalue';
import { normalizedText, words } from 'permalock';

/**
 * Identity for pages rendered from content collections.
 *
 * Astro keeps every collection entry, with its source file and rendered HTML,
 * in its data store. After the build we read it and find, for each page, the
 * entry whose text it contains. The entry's source file (or a `permalock`
 * field in its front matter) becomes the page's identity, so a changed slug is
 * recognised with certainty. This works with every Markdown processor and does
 * not touch the rendered output.
 */

export interface EntryInfo {
  source: string;
  anchors: string[];
}

const ANCHOR = 8;
const MIN_WORDS = 24;

function entryFrom(v: any): { source: string; text: string } | undefined {
  if (!v || typeof v !== 'object' || typeof v.filePath !== 'string') return undefined;
  const html = v.rendered && typeof v.rendered.html === 'string' ? v.rendered.html : undefined;
  const body = typeof v.body === 'string' ? v.body : undefined;
  if (!html && !body) return undefined;
  const fm = v.data && typeof v.data === 'object' ? v.data : {};
  const explicit = typeof fm.permalock === 'string' || typeof fm.permalock === 'number' ? String(fm.permalock) : undefined;
  const source = explicit ? `id:${explicit}` : v.filePath.split(path.sep).join('/');
  const text = html ? normalizedText(`<body>${html}</body>`) : body!.toLowerCase();
  return { source, text };
}

function collect(value: unknown, out: { source: string; text: string }[], depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return;
  if (value instanceof Map) {
    for (const v of value.values()) collect(v, out, depth + 1);
    return;
  }
  const e = entryFrom(value);
  if (e) {
    out.push(e);
    return;
  }
  if (Array.isArray(value)) for (const v of value) collect(v, out, depth + 1);
}

/** Anchors: up to four 8-word windows spread over the entry's text. */
export function anchorsFor(text: string): string[] {
  const ws = words(text);
  if (ws.length < MIN_WORDS) return [];
  const positions = [0, Math.floor(ws.length / 3), Math.floor((2 * ws.length) / 3), ws.length - ANCHOR];
  const out = new Set<string>();
  for (const p of positions) out.add(ws.slice(p, p + ANCHOR).join(' '));
  return [...out];
}

async function readStore(cacheDir: string): Promise<unknown[]> {
  const values: unknown[] = [];
  try {
    values.push(devalueParse(await fs.readFile(path.join(cacheDir, 'data-store.json'), 'utf8')));
  } catch {}
  // experimental.collectionStorage: "chunked"
  try {
    const dir = path.join(cacheDir, 'data-store');
    for (const f of await fs.readdir(dir)) {
      if (!/\.(txt|json)$/.test(f) || f === 'manifest.json') continue;
      try {
        values.push(devalueParse(await fs.readFile(path.join(dir, f), 'utf8')));
      } catch {}
    }
  } catch {}
  return values;
}

export async function loadEntries(cacheDir: string): Promise<EntryInfo[]> {
  const raw: { source: string; text: string }[] = [];
  for (const v of await readStore(cacheDir)) collect(v, raw);
  // an entry may appear in several stores: keep one per source
  const bySource = new Map<string, EntryInfo>();
  for (const r of raw) {
    const anchors = anchorsFor(r.text);
    if (anchors.length && !bySource.has(r.source)) bySource.set(r.source, { source: r.source, anchors });
  }
  return [...bySource.values()];
}

/**
 * Build a matcher: given the words of a page, return the source of the one
 * entry rendered in it, or undefined (no entry, or more than one).
 */
export function createMatcher(entries: EntryInfo[]) {
  const byFirst = new Map<string, EntryInfo[]>();
  for (const e of entries) {
    const k = e.anchors[0];
    const list = byFirst.get(k);
    if (list) list.push(e);
    else byFirst.set(k, [e]);
  }
  return (_url: string, ws: string[]): string | undefined => {
    if (!byFirst.size || ws.length < ANCHOR) return undefined;
    const grams = new Set<string>();
    for (let i = 0; i + ANCHOR <= ws.length; i++) grams.add(ws.slice(i, i + ANCHOR).join(' '));
    const found = new Set<string>();
    for (const g of grams) {
      const cands = byFirst.get(g);
      if (!cands) continue;
      for (const e of cands) {
        // every anchor must be present: excerpts on index pages do not match
        if (e.anchors.every((a) => grams.has(a))) found.add(e.source);
      }
    }
    return found.size === 1 ? [...found][0] : undefined;
  };
}
