import { createHash } from 'node:crypto';
import { MIN_WORDS } from './types.js';

const REMOVE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside'];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  middot: '·', bull: '•', eacute: 'é', egrave: 'è', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì',
  euro: '€', times: '×', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v ?? m;
  });
}

function innerOf(html: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const close = new RegExp(`</${tag}\\s*>`, 'ig');
  close.lastIndex = start;
  // account for nesting of the same tag
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'ig');
  let depth = 1;
  let pos = start;
  while (depth > 0) {
    close.lastIndex = pos;
    const c = close.exec(html);
    if (!c) return html.slice(start);
    openRe.lastIndex = pos;
    const o = openRe.exec(html);
    if (o && o.index < c.index) {
      depth++;
      pos = o.index + o[0].length;
    } else {
      depth--;
      pos = c.index + c[0].length;
      if (depth === 0) return html.slice(start, c.index);
    }
  }
  return undefined;
}

/** Normalised main text of a page (spec 2.5.1). */
export function normalizedText(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = innerOf(h, 'main') ?? innerOf(h, 'article') ?? innerOf(h, 'body') ?? h;
  for (const tag of REMOVE_TAGS) {
    h = h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
    h = h.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), ' ');
  }
  h = h.replace(/<[^>]*>/g, ' ');
  return decodeEntities(h).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

const TWO32 = 4294967296;

/** FNV-1a 64 over UTF-8 bytes, returned as [hi, lo] unsigned 32-bit halves. */
export function fnv1a64(s: string): [number, number] {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const step = (byte: number) => {
    lo = (lo ^ byte) >>> 0;
    // multiply (hi, lo) by 0x100000001b3 = 2^40 + 0x1b3, mod 2^64
    const t = lo * 0x1b3;
    const carry = Math.floor(t / TWO32);
    hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = t >>> 0;
  };
  // inline UTF-8 encoding (no allocation)
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) step(c);
    else if (c < 0x800) {
      step(0xc0 | (c >> 6));
      step(0x80 | (c & 63));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      step(0xf0 | (c >> 18));
      step(0x80 | ((c >> 12) & 63));
      step(0x80 | ((c >> 6) & 63));
      step(0x80 | (c & 63));
    } else {
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd; // lone surrogate, as TextEncoder does
      step(0xe0 | (c >> 12));
      step(0x80 | ((c >> 6) & 63));
      step(0x80 | (c & 63));
    }
  }
  return [hi, lo];
}

function hex8(n: number) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** 64-bit SimHash over word 3-grams (spec 2.5.2). */
export function simhash(ws: string[]): string {
  const counts = new Int32Array(64);
  const features: string[] = [];
  if (ws.length < 3) features.push(...ws);
  else for (let i = 0; i + 2 < ws.length; i++) features.push(`${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`);
  for (const f of features) {
    const [hi, lo] = fnv1a64(f);
    for (let b = 0; b < 32; b++) {
      counts[b] += (lo >>> b) & 1 ? 1 : -1;
      counts[32 + b] += (hi >>> b) & 1 ? 1 : -1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let b = 0; b < 32; b++) {
    if (counts[b] > 0) lo |= 1 << b;
    if (counts[32 + b] > 0) hi |= 1 << b;
  }
  return hex8(hi) + hex8(lo);
}

function popcount32(n: number) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** 1 - hamming(a, b) / 64 */
export function simSimilarity(a: string, b: string): number {
  const ahi = parseInt(a.slice(0, 8), 16), alo = parseInt(a.slice(8), 16);
  const bhi = parseInt(b.slice(0, 8), 16), blo = parseInt(b.slice(8), 16);
  const d = popcount32((ahi ^ bhi) >>> 0) + popcount32((alo ^ blo) >>> 0);
  return 1 - d / 64;
}

export interface Fingerprint {
  hash?: string;
  sim?: string;
  words: number;
}

/** hash and sim are omitted for pages too short to compare. */
export function fingerprint(html: string): Fingerprint {
  const text = normalizedText(html);
  return fingerprintText(text, words(text));
}

export function fingerprintText(text: string, ws: string[]): Fingerprint {
  if (ws.length < MIN_WORDS) return { words: ws.length };
  return { hash: contentHash(text), sim: simhash(ws), words: ws.length };
}

/** Parse `<meta http-equiv="refresh" content="0;url=...">` and return the target. */
export function metaRefreshTarget(html: string): string | undefined {
  const head = html.slice(0, 4096);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  for (const m of metas) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(m)) continue;
    const c = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m);
    const content = decodeEntities(c?.[2] ?? c?.[3] ?? '');
    const u = /^\s*(\d+)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i.exec(content);
    if (u && Number(u[1]) <= 1) return u[2].trim();
  }
  return undefined;
}

export function metaContent(html: string, name: string): string | undefined {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const m of metas) {
    const n = /name\s*=\s*["']([^"']+)["']/i.exec(m);
    if (!n || n[1].toLowerCase() !== name.toLowerCase()) continue;
    const c = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m);
    if (c) return decodeEntities(c[2] ?? c[3] ?? '');
  }
  return undefined;
}

/** Source markers injected by framework integrations: data-permalock-source="..." */
export function sourceMarkers(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/data-permalock-source\s*=\s*"([^"]*)"/g)) out.add(decodeEntities(m[1]));
  return [...out];
}

export function stripSourceMarkers(html: string): string {
  return html.replace(/<span\b[^>]*\bdata-permalock-source="[^"]*"[^>]*><\/span>/g, '');
}
