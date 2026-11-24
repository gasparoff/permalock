import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAbsoluteUrl } from './resolve.js';
import type { Lockfile } from './types.js';

export const EMIT_FORMATS = ['netlify', 'cloudflare', 'vercel', 'html', 'nginx', 'apache', 'json'] as const;
export type EmitFormat = (typeof EMIT_FORMATS)[number];

export interface EmitFile {
  path: string;
  content: string;
  /** "block": replace the permalock block inside an existing file, "json-redirects": merge vercel.json, "create": write only if absent */
  mode: 'write' | 'block' | 'json-redirects' | 'create';
}

export interface EmitResult {
  files: EmitFile[];
  warnings: string[];
  redirects: number;
  gone: number;
}

const START = '# permalock:start (generated from permalock.json, do not edit)';
const END = '# permalock:end';

function entries(lock: Lockfile) {
  const redirects: [string, string][] = [];
  const gone: string[] = [];
  for (const url of Object.keys(lock.urls).sort()) {
    const e = lock.urls[url];
    if (e.type === 'redirect') redirects.push([url, e.to]);
    else if (e.type === 'gone') gone.push(url);
  }
  return { redirects, gone };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function redirectHtml(to: string, site?: string): string {
  const abs = isAbsoluteUrl(to) || !site ? to : site.replace(/\/$/, '') + to;
  const t = escapeHtml(to);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Moved</title>
<meta http-equiv="refresh" content="0;url=${t}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${escapeHtml(abs)}">
</head><body><p>This page moved to <a href="${t}">${t}</a>.</p></body></html>
`;
}

/** File (relative to the output dir) where an HTML redirect page for `url` goes. */
export function htmlFileFor(url: string, base = ''): string | undefined {
  let p = decodeURI(url);
  if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
  if (p.endsWith('/')) return path.join(...p.split('/').filter(Boolean), 'index.html');
  if (p.endsWith('.html')) return path.join(...p.split('/').filter(Boolean));
  return path.join(...p.split('/').filter(Boolean)) + '.html';
}

export interface EmitOptions {
  /** Output directory (build dir for netlify/cloudflare/html, project root for vercel). */
  out: string;
  /** Base path stripped when mapping URLs to files (html format). */
  base?: string;
}

export function emit(lock: Lockfile, format: EmitFormat, opts: EmitOptions): EmitResult {
  const { redirects, gone } = entries(lock);
  const warnings: string[] = [];
  const files: EmitFile[] = [];
  let goneCount = gone.length;
  switch (format) {
    case 'netlify':
    case 'cloudflare': {
      const lines = redirects.map(([f, t]) => `${f} ${t} 301`);
      if (format === 'netlify') lines.push(...gone.map((g) => `${g} /404.html 410!`));
      else if (gone.length) {
        warnings.push(`Cloudflare _redirects cannot answer 410: ${gone.length} removed URL(s) will answer 404, which permalock accepts as a declared removal.`);
        goneCount = 0;
      }
      if (format === 'cloudflare' && redirects.length > 2000)
        warnings.push(`Cloudflare Pages allows 2,000 static redirects; you have ${redirects.length}. Use Bulk Redirects for the rest.`);
      files.push({ path: path.join(opts.out, '_redirects'), content: [START, ...lines, END].join('\n') + '\n', mode: 'block' });
      break;
    }
    case 'vercel': {
      const json = redirects.map(([source, destination]) => ({ source, destination, statusCode: 301 }));
      if (gone.length) {
        warnings.push(`vercel.json redirects cannot answer 410: ${gone.length} removed URL(s) will answer 404.`);
        goneCount = 0;
      }
      files.push({ path: path.join(opts.out, 'vercel.json'), content: JSON.stringify(json), mode: 'json-redirects' });
      break;
    }
    case 'html': {
      for (const [f, t] of redirects) {
        const file = htmlFileFor(f, opts.base);
        if (!file) continue;
        files.push({ path: path.join(opts.out, file), content: redirectHtml(t, lock.site), mode: 'create' });
      }
      if (redirects.length)
        warnings.push('HTML redirect pages answer 200 with a meta refresh ("soft redirects"). Prefer real 301s where your host supports them.');
      if (gone.length) {
        warnings.push(`Static files cannot answer 410: ${gone.length} removed URL(s) will answer 404.`);
        goneCount = 0;
      }
      break;
    }
    case 'nginx': {
      const lines = [
        ...redirects.map(([f, t]) => `location = ${f} { return 301 ${t}; }`),
        ...gone.map((g) => `location = ${g} { return 410; }`),
      ];
      files.push({ path: path.join(opts.out, 'permalock.nginx.conf'), content: [START, ...lines, END].join('\n') + '\n', mode: 'write' });
      break;
    }
    case 'apache': {
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
      const lines = [
        ...redirects.map(([f, t]) => `Redirect 301 ${q(f)} ${q(t)}`),
        ...gone.map((g) => `Redirect gone ${q(g)}`),
      ];
      files.push({ path: path.join(opts.out, '.htaccess'), content: [START, ...lines, END].join('\n') + '\n', mode: 'block' });
      break;
    }
    case 'json': {
      const content = JSON.stringify({ redirects: Object.fromEntries(redirects), gone }, null, 2) + '\n';
      files.push({ path: path.join(opts.out, 'permalock.redirects.json'), content, mode: 'write' });
      break;
    }
  }
  return { files, warnings, redirects: redirects.length, gone: goneCount };
}

export function replaceBlock(existing: string, block: string): string {
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s !== -1 && e > s) return existing.slice(0, s) + block.trimEnd() + existing.slice(e + END.length);
  // Our rules go first: on Netlify and Cloudflare the first matching rule wins,
  // and a catch-all rule written by hand must not shadow them.
  return block + (existing ? '\n' + existing : '');
}

/** Write emitted files to disk. Returns the files actually written or skipped. */
export async function writeEmitted(result: EmitResult): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of result.files) {
    await fs.mkdir(path.dirname(f.path), { recursive: true });
    let existing: string | undefined;
    try {
      existing = await fs.readFile(f.path, 'utf8');
    } catch {}
    let content = f.content;
    if (f.mode === 'create' && existing !== undefined) {
      skipped.push(f.path);
      continue;
    }
    if (f.mode === 'block' && existing !== undefined) content = replaceBlock(existing, f.content);
    if (f.mode === 'json-redirects') {
      const ours = JSON.parse(f.content) as { source: string }[];
      const cfg = existing ? JSON.parse(existing) : {};
      const mine = new Set(ours.map((r) => r.source));
      const kept = (Array.isArray(cfg.redirects) ? cfg.redirects : []).filter((r: any) => !mine.has(r.source));
      cfg.redirects = [...ours, ...kept];
      content = JSON.stringify(cfg, null, 2) + '\n';
    }
    if (content === existing) continue;
    await fs.writeFile(f.path, content);
    written.push(f.path);
  }
  return { written, skipped };
}
