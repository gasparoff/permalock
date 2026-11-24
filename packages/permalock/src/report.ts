import type { Resolution } from './types.js';

const useColor = () => !process.env.NO_COLOR && (process.env.FORCE_COLOR || process.stdout.isTTY);
const wrap = (code: number, end: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[${end}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export function reasonLabel(reason: string): string {
  if (reason === 'same-source') return 'same source file';
  if (reason === 'same-content') return 'identical content';
  if (reason === 'config') return 'redirect already in config';
  if (reason === 'manual') return 'manual';
  const m = /^similar:(.+)$/.exec(reason);
  if (m) return `similar content (${m[1]})`;
  return reason;
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export interface FormatOptions {
  /** Max new pages listed one by one. Default 10 */
  maxAdded?: number;
  /** Command prefix used in fix hints. Default "permalock" */
  cmd?: string;
}

export function summaryLine(r: Resolution): string {
  const total = Object.keys(r.lock.urls).length;
  const parts = [plural(total, 'URL') + ' locked'];
  if (r.added.length) parts.push(`${r.added.length} new`);
  if (r.redirected.length) parts.push(`${plural(r.redirected.length, 'redirect')} created`);
  if (r.revived.length) parts.push(`${r.revived.length} revived`);
  if (r.orphans.length) parts.push(c.red(plural(r.orphans.length, 'orphan')));
  if (r.errors.length) parts.push(c.red(plural(r.errors.length, 'error')));
  return parts.join(' · ');
}

export function formatResolution(r: Resolution, opts: FormatOptions = {}): string {
  const cmd = opts.cmd ?? 'permalock';
  const maxAdded = opts.maxAdded ?? 10;
  const lines: string[] = [];
  const w = Math.min(
    48,
    Math.max(10, ...r.redirected.map((x) => x.from.length + x.to.length + 3), ...r.added.slice(0, maxAdded).map((u) => u.length)),
  );
  const pad = (s: string) => s + ' '.repeat(Math.max(1, w - s.length + 2));
  if (r.added.length <= maxAdded) for (const u of r.added) lines.push(`  ${c.green('+')} ${pad(u)}${c.dim('new page')}`);
  else lines.push(`  ${c.green('+')} ${plural(r.added.length, 'new page')}`);
  for (const x of r.revived) lines.push(`  ${c.green('↺')} ${pad(x.url)}${c.dim(`page again (was ${x.was})`)}`);
  for (const x of r.redirected) lines.push(`  ${c.cyan('→')} ${pad(`${x.from} → ${x.to}`)}${c.dim(reasonLabel(x.reason))}`);
  for (const x of r.collapsed) lines.push(`  ${c.cyan('⤷')} ${pad(`${x.from} → ${x.now}`)}${c.dim(`chain collapsed (was → ${x.was})`)}`);
  for (const o of r.orphans) {
    lines.push(`  ${c.red('✗')} ${pad(o.url)}${c.red('orphan')}${o.origin ? c.dim(` (from ${o.origin})`) : ''}`);
    if (o.suggestion) {
      lines.push(
        c.dim(
          o.suggestion.basis === 'redirect'
            ? `      this redirect is no longer in your site's configuration (it went to ${o.suggestion.to})`
            : `      suggestion: ${o.suggestion.to}  (${o.suggestion.basis} ${o.suggestion.score.toFixed(2)})`,
        ),
      );
      lines.push(c.dim(`      fix: ${cmd} redirect ${o.url} ${o.suggestion.to}   or   ${cmd} retire ${o.url}`));
    } else lines.push(c.dim(`      fix: ${cmd} redirect ${o.url} <new-url>   or   ${cmd} retire ${o.url}`));
  }
  for (const e of r.errors) lines.push(`  ${c.red('✗')} ${pad(e.url)}${c.red(e.kind)}: ${e.message}`);
  return lines.join('\n');
}
