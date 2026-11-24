#!/usr/bin/env node
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { addRedirect, DecisionError, forget, retire, toUrlKey } from './decide.js';
import { emit, EMIT_FORMATS, writeEmitted, type EmitFormat } from './emit.js';
import { checkLive, collectHistory, domainOf } from './history.js';
import { emptyLockfile, LOCKFILE_NAME, LockfileError, parseLockfile, readLockfile, serializeLockfile, writeLockfile } from './lockfile.js';
import { mergeLockfiles } from './merge.js';
import { checkProject } from './project.js';
import { c, formatResolution, reasonLabel, summaryLine } from './report.js';
import { passes, pathSimilarity } from './resolve.js';
import { detectBuildDir } from './scan.js';
import { renderScanHtml, renderScanText, summarizeScan } from './scanreport.js';
import { verify } from './verify.js';
import type { Lockfile, Orphan } from './types.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `${c.bold('permalock')} ${VERSION}: URLs are a public API. This is their lockfile.

Usage: permalock <command> [options]

In a project
  update [dir]                 Scan the build, update permalock.json, report changes
  check [dir]                  Same, for CI: fails on orphan URLs, writes nothing
  resolve [dir]                Decide orphan URLs one by one (interactive)
  redirect <from> <to>         Record a permanent redirect
  retire <url> [--reason txt]  Declare a URL removed on purpose (410 where possible)
  forget <url>                 Drop a URL that was never public
  emit <format> [--out dir]    Write redirects for your host: ${EMIT_FORMATS.join(', ')}
  verify [--against <url>]     Check every locked URL on the deployed site
  import <domain>              Add URLs the domain published in the past (Wayback, sitemaps)
  init                         Create permalock.json and set up the git merge driver

Anywhere
  scan <domain>                How many URLs has this site lost? No install needed

Options
  --lockfile <file>      Default ./permalock.json
  --base <path>          Base path the site is served under (e.g. /docs)
  --site <url>           Canonical origin, saved in a new lockfile
  --exclude <glob>       URL paths to ignore (repeatable)
  --html-extension keep  Serve about.html as /about.html instead of /about
  --no-similar           Never create redirects from estimated similarity
  --frozen               check: also fail when permalock.json is out of date
  --json                 Machine-readable output
  -h, --help             Show help
`;

const opts = {
  lockfile: { type: 'string' },
  base: { type: 'string' },
  site: { type: 'string' },
  exclude: { type: 'string', multiple: true },
  'html-extension': { type: 'string' },
  'no-similar': { type: 'boolean' },
  frozen: { type: 'boolean' },
  json: { type: 'boolean' },
  reason: { type: 'string' },
  out: { type: 'string' },
  against: { type: 'string' },
  concurrency: { type: 'string' },
  sample: { type: 'string' },
  'allow-soft': { type: 'boolean' },
  html: { type: 'string' },
  max: { type: 'string' },
  'no-wayback': { type: 'boolean' },
  'check-live': { type: 'boolean' },
  install: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Values = ReturnType<typeof parse>['values'];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options: opts, allowPositionals: true, strict: true });
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [cmd, ...args] = positionals;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }
  const cwd = process.cwd();
  const lockfilePath = path.resolve(cwd, values.lockfile ?? LOCKFILE_NAME);

  switch (cmd) {
    case 'update':
    case 'check':
    case 'status':
      return runCheck(cmd === 'update', args[0], values, lockfilePath);
    case 'init':
      return runInit(args[0], values, lockfilePath);
    case 'resolve':
      return runResolve(args[0], values, lockfilePath);
    case 'redirect': {
      if (args.length !== 2) throw new UsageError('usage: permalock redirect <from> <to>');
      const lock = await mustRead(lockfilePath);
      const errors = addRedirect(lock, args[0], args[1]);
      await writeLockfile(lockfilePath, lock);
      const from = toUrlKey(args[0], lock.site);
      console.log(`${c.cyan('→')} ${from} → ${lock.urls[from].to}`);
      for (const e of errors) console.log(`${c.yellow('!')} ${e.url}: ${e.message}`);
      return 0;
    }
    case 'retire': {
      if (args.length !== 1) throw new UsageError('usage: permalock retire <url> [--reason text]');
      const lock = await mustRead(lockfilePath);
      const pointing = retire(lock, args[0], values.reason);
      await writeLockfile(lockfilePath, lock);
      console.log(`${c.dim('✝')} ${toUrlKey(args[0], lock.site)} declared removed`);
      if (pointing.length)
        console.log(c.yellow(`! ${pointing.length} redirect(s) pointed here and now lead nowhere: ${pointing.join(', ')}`));
      return 0;
    }
    case 'forget': {
      if (args.length !== 1) throw new UsageError('usage: permalock forget <url>');
      const lock = await mustRead(lockfilePath);
      if (!forget(lock, args[0])) {
        console.error(`${args[0]} is not in ${path.basename(lockfilePath)}`);
        return 1;
      }
      await writeLockfile(lockfilePath, lock);
      console.log(`${toUrlKey(args[0], lock.site)} removed from ${path.basename(lockfilePath)}`);
      return 0;
    }
    case 'emit':
      return runEmit(args[0], values, lockfilePath, cwd);
    case 'verify':
      return runVerify(values, lockfilePath);
    case 'scan':
      return runScan(args[0], values);
    case 'import':
      return runImport(args[0], values, lockfilePath);
    case 'merge-driver':
      return runMergeDriver(args, values);
    default:
      throw new UsageError(`unknown command "${cmd}". Run permalock --help`);
  }
}

async function mustRead(file: string): Promise<Lockfile> {
  const lock = await readLockfile(file);
  if (!lock) throw new UsageError(`${path.basename(file)} not found. Build your site and run "permalock update" first.`);
  return lock;
}

async function buildDir(arg: string | undefined): Promise<string> {
  if (arg) return path.resolve(arg);
  const d = await detectBuildDir(process.cwd());
  if (!d) throw new UsageError('No build directory found (looked for dist, build, out, _site, public). Pass it: permalock update <dir>');
  return d;
}

function scanOpts(values: Values) {
  return {
    base: values.base,
    exclude: values.exclude,
    htmlExtension: values['html-extension'] === 'keep' ? ('keep' as const) : ('strip' as const),
    site: values.site,
    resolve: values['no-similar'] ? { autoThreshold: false as const } : undefined,
  };
}

async function runCheck(write: boolean, dirArg: string | undefined, values: Values, lockfilePath: string): Promise<number> {
  const dir = await buildDir(dirArg);
  const t0 = Date.now();
  const r = await checkProject({ dir, lockfile: lockfilePath, write, ...scanOpts(values) });
  const res = r.resolution;
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ok: passes(res),
          created: r.created,
          changed: res.changed,
          written: r.written,
          added: res.added,
          revived: res.revived,
          redirected: res.redirected,
          collapsed: res.collapsed,
          orphans: res.orphans.map((o) => ({ ...o, fixes: fixesFor(o) })),
          errors: res.errors,
        },
        null,
        2,
      ),
    );
  } else {
    if (r.created && write) {
      console.log(`${c.bold('permalock')} created ${path.relative(process.cwd(), r.lockfilePath)} with ${res.added.length} URLs. Commit it: from now on these URLs are protected.`);
    } else {
      console.log(`${c.bold('permalock')} ${summaryLine(res)} ${c.dim(`(${Date.now() - t0} ms)`)}`);
      const body = formatResolution(res);
      if (body) console.log(body);
      if (write && r.written) console.log(c.dim(`Updated ${path.relative(process.cwd(), r.lockfilePath)}: commit it with your change.`));
      if (!write && res.changed && !values.frozen && passes(res))
        console.log(c.yellow(`! permalock.json is out of date. Run "permalock update" locally and commit it.`));
    }
  }
  if (!passes(res)) {
    if (!values.json) console.log(c.red(`\n${res.orphans.length + res.errors.length} URL(s) would break. Decide each one, then build again.`));
    return 1;
  }
  if (!write && values.frozen && res.changed) {
    if (!values.json) console.log(c.red('permalock.json is out of date (--frozen). Run "permalock update" and commit it.'));
    return 1;
  }
  return 0;
}

/** Commands that settle an orphan, ready to run: what an agent needs to act on --json output. */
function fixesFor(o: Orphan): string[] {
  const q = (u: string) => (/^[\w\-./:%~]+$/.test(u) ? u : `'${u.replace(/'/g, `'\\''`)}'`);
  const to = o.suggestion?.to;
  return [...(to ? [`permalock redirect ${q(o.url)} ${q(to)}`] : []), `permalock retire ${q(o.url)} --reason "<why>"`];
}

async function runInit(dirArg: string | undefined, values: Values, lockfilePath: string): Promise<number> {
  const existing = await readLockfile(lockfilePath);
  if (!existing) {
    const dir = dirArg ? path.resolve(dirArg) : await detectBuildDir(process.cwd());
    if (dir) {
      const r = await checkProject({ dir, lockfile: lockfilePath, ...scanOpts(values) });
      console.log(`${c.green('✓')} created ${path.basename(lockfilePath)} with ${r.resolution.added.length} URLs from ${path.relative(process.cwd(), dir) || '.'}`);
    } else {
      await writeLockfile(lockfilePath, emptyLockfile(values.site));
      console.log(`${c.green('✓')} created an empty ${path.basename(lockfilePath)} (build your site, then run "permalock update")`);
    }
  } else console.log(`${c.dim('·')} ${path.basename(lockfilePath)} already exists (${Object.keys(existing.urls).length} URLs)`);
  await installMergeDriver();
  return 0;
}

async function installMergeDriver() {
  const attrs = path.resolve('.gitattributes');
  let text = '';
  try {
    text = await fs.readFile(attrs, 'utf8');
  } catch {}
  const line = 'permalock*.json merge=permalock';
  if (!text.includes(line)) {
    await fs.writeFile(attrs, (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n');
    console.log(`${c.green('✓')} .gitattributes: permalock.json merges with the permalock driver`);
  }
  try {
    execFileSync('git', ['config', 'merge.permalock.name', 'permalock lockfile merge'], { stdio: 'ignore' });
    execFileSync('git', ['config', 'merge.permalock.driver', 'npx --no-install permalock merge-driver %O %A %B'], { stdio: 'ignore' });
    console.log(`${c.green('✓')} git merge driver configured for this clone (each clone runs "permalock merge-driver --install" once)`);
  } catch {
    console.log(c.dim('· not a git repository: skipped the merge driver'));
  }
}

async function runMergeDriver(args: string[], values: Values): Promise<number> {
  if (values.install) {
    await installMergeDriver();
    return 0;
  }
  if (args.length !== 3) throw new UsageError('usage: permalock merge-driver <base> <ours> <theirs>  (or --install)');
  const [b, o, t] = await Promise.all(args.map((f) => fs.readFile(f, 'utf8').catch(() => '')));
  const parseOr = (s: string) => (s.trim() ? parseLockfile(s) : emptyLockfile());
  const r = mergeLockfiles(parseOr(b), parseOr(o), parseOr(t));
  await fs.writeFile(args[1], serializeLockfile(r.lock));
  if (r.conflicts.length) {
    console.error(`permalock: ${r.conflicts.length} URL(s) changed differently on both branches (kept ours):`);
    for (const x of r.conflicts) console.error(`  ${x.url}: ours ${x.ours?.type ?? 'deleted'}, theirs ${x.theirs?.type ?? 'deleted'}`);
    return 1;
  }
  return 0;
}

async function runResolve(dirArg: string | undefined, values: Values, lockfilePath: string): Promise<number> {
  const dir = await buildDir(dirArg);
  const r = await checkProject({ dir, lockfile: lockfilePath, write: true, ...scanOpts(values) });
  const lock = r.resolution.lock;
  const orphans = r.resolution.orphans;
  if (!orphans.length) {
    console.log(`${c.green('✓')} no orphan URLs. ${summaryLine(r.resolution)}`);
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.log(formatResolution(r.resolution));
    console.log(c.yellow('\nresolve is interactive: run it in a terminal, or use "permalock redirect" and "permalock retire".'));
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pages = Object.keys(lock.urls).filter((u) => lock.urls[u].type === 'page' && !orphans.some((o) => o.url === u));
  let decided = 0;
  try {
    for (const [i, o] of orphans.entries()) {
      console.log(`\n${c.bold(`[${i + 1}/${orphans.length}]`)} ${c.red(o.url)} ${o.origin ? c.dim(`(from ${o.origin})`) : ''}`);
      const options = o.suggestion
        ? [o.suggestion.to]
        : pages
            .map((p) => [p, pathSimilarity(o.url, p)] as const)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map((x) => x[0]);
      options.forEach((p, k) => console.log(`  ${k + 1}) redirect to ${p}`));
      console.log(`  g) gone (removed on purpose)   /path) redirect to another URL   s) skip   q) quit`);
      const a = (await rl.question('> ')).trim();
      if (a === 'q') break;
      if (a === '' || a === 's') continue;
      if (a === 'g') {
        const reason = (await rl.question('reason (optional): ')).trim();
        retire(lock, o.url, reason || undefined);
      } else if (/^\d+$/.test(a) && options[Number(a) - 1]) addRedirect(lock, o.url, options[Number(a) - 1]);
      else if (a.startsWith('/') || /^https:\/\//.test(a)) addRedirect(lock, o.url, a);
      else {
        console.log(c.yellow('not understood, skipped'));
        continue;
      }
      decided++;
      await writeLockfile(lockfilePath, lock);
    }
  } finally {
    rl.close();
  }
  console.log(`\n${decided} decision(s) saved to ${path.basename(lockfilePath)}.`);
  return decided === orphans.length ? 0 : 1;
}

async function runEmit(format: string | undefined, values: Values, lockfilePath: string, cwd: string): Promise<number> {
  if (!format || !(EMIT_FORMATS as readonly string[]).includes(format))
    throw new UsageError(`usage: permalock emit <${EMIT_FORMATS.join('|')}> [--out dir]`);
  const lock = await mustRead(lockfilePath);
  const out = values.out ? path.resolve(values.out) : format === 'vercel' ? cwd : (await detectBuildDir(cwd)) ?? cwd;
  const res = emit(lock, format as EmitFormat, { out, base: values.base });
  const { written, skipped } = await writeEmitted(res);
  console.log(`${c.green('✓')} ${res.redirects} redirect(s)${res.gone ? `, ${res.gone} removal(s)` : ''} → ${written.length ? written.map((f) => path.relative(cwd, f)).slice(0, 5).join(', ') + (written.length > 5 ? ` and ${written.length - 5} more` : '') : 'nothing changed'}`);
  if (skipped.length) console.log(c.dim(`· ${skipped.length} file(s) already exist and were left alone`));
  for (const w of res.warnings) console.log(c.yellow(`! ${w}`));
  return 0;
}

async function runVerify(values: Values, lockfilePath: string): Promise<number> {
  const lock = await mustRead(lockfilePath);
  const isTTY = process.stderr.isTTY && !values.json;
  const r = await verify(lock, {
    against: values.against,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    sample: values.sample ? Number(values.sample) : undefined,
    onProgress: isTTY ? (d, t) => process.stderr.write(`\r${c.dim(`checking ${d}/${t}`)}`) : undefined,
  });
  if (isTTY) process.stderr.write('\r\x1b[K');
  const allowSoft = !!values['allow-soft'];
  const failing = r.items.filter((i) => i.status === 'fail' || i.status === 'error' || (i.status === 'soft' && !allowSoft));
  if (values.json) {
    console.log(JSON.stringify({ ok: failing.length === 0, origin: r.origin, counts: r.counts, failures: failing }, null, 2));
    return failing.length ? 1 : 0;
  }
  console.log(`${c.bold('permalock verify')} ${r.origin}: ${c.green(`${r.counts.pass} pass`)} · ${r.counts.soft ? c.yellow(`${r.counts.soft} soft`) : '0 soft'} · ${r.counts.fail ? c.red(`${r.counts.fail} fail`) : '0 fail'}${r.counts.error ? ` · ${c.red(`${r.counts.error} error`)}` : ''}`);
  for (const i of failing.slice(0, 50)) {
    const mark = i.status === 'soft' ? c.yellow('~') : c.red('✗');
    console.log(`  ${mark} ${i.url}  ${c.dim(`expected ${i.expected}, got ${i.observed}`)}`);
    if (i.hint) console.log(c.dim(`      ${i.hint}`));
  }
  if (failing.length > 50) console.log(c.dim(`  … and ${failing.length - 50} more (use --json)`));
  if (r.counts.soft && allowSoft) console.log(c.dim(`${r.counts.soft} soft redirect(s) accepted (--allow-soft)`));
  return failing.length ? 1 : 0;
}

async function runScan(domainArg: string | undefined, values: Values): Promise<number> {
  if (!domainArg) throw new UsageError('usage: permalock scan <domain> [--html report.html] [--json] [--max N]');
  const domain = domainOf(domainArg);
  const progress = !values.json && process.stderr.isTTY;
  const step = (m: string) => progress && process.stderr.write(`\r\x1b[K${c.dim(m)}`);
  step(`collecting the history of ${domain}…`);
  const history = await collectHistory(domain, { wayback: !values['no-wayback'], onStep: step });
  const max = values.max ? Number(values.max) : 2000;
  const paths = history.urls.map((u) => u.path);
  const sample = paths.length > max ? paths.filter((_, i) => i % Math.ceil(paths.length / max) === 0) : paths;
  const live = await checkLive(domain, sample, {
    concurrency: values.concurrency ? Number(values.concurrency) : 8,
    onProgress: (d, t) => step(`checking ${d}/${t} URLs on https://${domain}…`),
  });
  if (progress) process.stderr.write('\r\x1b[K');
  const summary = summarizeScan(history, live, paths.length);
  if (values.html) {
    await fs.writeFile(values.html, renderScanHtml(summary));
    if (!values.json) console.log(c.dim(`report written to ${values.html}`));
  }
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(renderScanText(summary));
  return 0;
}

async function runImport(domainArg: string | undefined, values: Values, lockfilePath: string): Promise<number> {
  if (!domainArg) throw new UsageError('usage: permalock import <domain> [--check-live] [--no-wayback]');
  const lock = await mustRead(lockfilePath);
  const domain = domainOf(domainArg);
  if (!lock.site) lock.site = `https://${domain}`;
  console.log(c.dim(`collecting the history of ${domain}…`));
  const history = await collectHistory(domain, { wayback: !values['no-wayback'] });
  for (const e of history.errors) console.log(c.yellow(`! ${e}`));
  const base = values.base ? '/' + values.base.replace(/^\/+|\/+$/g, '') : '';
  const unknown = history.urls.filter((h) => !(h.path in lock.urls) && !(h.path + '/' in lock.urls) && (!base || h.path.startsWith(base)));
  let adopted = 0, skippedLive = 0;
  let toAdd = unknown;
  if (values['check-live'] && unknown.length) {
    const live = await checkLive(domain, unknown.map((u) => u.path));
    const byPath = new Map(live.map((l) => [l.path, l]));
    toAdd = [];
    for (const u of unknown) {
      const l = byPath.get(u.path)!;
      if (l.state === 'redirect' && l.final) {
        const target = new URL(l.final);
        const known = lock.urls[target.pathname];
        if (known?.type === 'page' && target.host.replace(/^www\./, '') === domain) {
          lock.urls[u.path] = { type: 'redirect', to: target.pathname, reason: 'adopted from live site' };
          adopted++;
          continue;
        }
      }
      if (l.state === 'ok') {
        skippedLive++;
        continue;
      }
      toAdd.push(u);
    }
  }
  for (const u of toAdd) lock.urls[u.path] = { type: 'page', origin: u.origin };
  await writeLockfile(lockfilePath, lock);
  console.log(
    `${c.green('✓')} ${history.urls.length} historic URLs found (${Object.entries(history.sources).map(([k, v]) => `${k} ${v}`).join(', ')}). ` +
      `${toAdd.length} added to ${path.basename(lockfilePath)}${adopted ? `, ${adopted} existing redirects adopted` : ''}${skippedLive ? `, ${skippedLive} still served by something outside the build (skipped)` : ''}.`,
  );
  if (toAdd.length) console.log(`Next: build, then run ${c.bold('permalock resolve')} to decide where each old URL goes.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError || e instanceof DecisionError || e instanceof LockfileError) {
      console.error(c.red(`permalock: ${e.message}`));
      process.exit(2);
    }
    console.error(e);
    process.exit(2);
  },
);

export { reasonLabel };
