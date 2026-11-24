#!/usr/bin/env node
// Replays the history of a docs site's git repository commit by commit, as if
// Permalock had run in CI on every merge, and compares its automatic redirects
// with the redirects the maintainers wrote by hand.
//
// Usage: node bench/git-history.mjs <repo-dir> [--lang en] [--rules worker.js]
//
// Approximations (stated in the report):
// - pages come from content files, not from a build: src/pages/<lang>/** and
//   src/content/docs/<lang>/** (.md, .mdx, .astro), URL = /<lang>/<path>/;
// - text is the source with front matter, imports and code fences removed;
// - identity is the file path, which on these sites is the URL itself, so only
//   the content rules (identical content, similar content) can fire.
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { contentHash, resolve, simhash, words } from '../packages/permalock/dist/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { lang: { type: 'string', default: 'en' }, rules: { type: 'string', default: 'worker.js' }, json: { type: 'string' } },
});
const repo = positionals[0];
if (!repo) throw new Error('usage: node bench/git-history.mjs <repo-dir>');
const lang = values.lang;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

const PATH_RE = new RegExp(`^src/(?:pages|content/docs)/${lang}/(.+)\\.(md|mdx|astro)$`);
function urlFor(file) {
  const m = PATH_RE.exec(file);
  if (!m || m[1].includes('[') || m[1].split('/').some((s) => s.startsWith('_'))) return undefined;
  let p = m[1];
  if (p === 'index') return `/${lang}/`;
  if (p.endsWith('/index')) p = p.slice(0, -6);
  return `/${lang}/${p}/`;
}

// --- blob reader with cache -------------------------------------------------
const textCache = new Map();
const catFile = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
const waiters = [];
catFile.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0 || !waiters.length) return;
    const header = buf.subarray(0, nl).toString();
    const size = Number(header.split(' ')[2]);
    if (buf.length < nl + 1 + size + 1) return;
    const body = buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
    buf = buf.subarray(nl + 1 + size + 1);
    waiters.shift()(body);
  }
});
function readBlob(sha) {
  return new Promise((res) => {
    waiters.push(res);
    catFile.stdin.write(sha + '\n');
  });
}

function sourceText(src) {
  return src
    .replace(/^---[\s\S]*?\n---\n/, ' ')
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/^\s*import .*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .toLowerCase();
}

async function fingerprintBlob(sha) {
  let fp = textCache.get(sha);
  if (fp) return fp;
  const ws = words(sourceText(await readBlob(sha)));
  fp = ws.length < 40 ? {} : { hash: contentHash(ws.join(' ')), sim: simhash(ws) };
  textCache.set(sha, fp);
  return fp;
}

// --- human ground truth: redirect rules at HEAD -----------------------------
function loadRules() {
  let src = '';
  try {
    src = git('show', `HEAD:${values.rules}`);
  } catch {
    return [];
  }
  const rules = [];
  for (const m of src.matchAll(/\[\s*'([^']+)',\s*'([^']+)'/g)) rules.push([m[1], m[2]]);
  return rules;
}
const rules = loadRules();
const norm = (p) => p.replace(/#.*$/, '').replace(/\/?$/, '/');
function humanTarget(url) {
  for (const [from, to] of rules) {
    const names = [];
    const re = new RegExp(
      '^' +
        from
          .replace(/\/$/, '')
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/:([a-z]+)/g, (_, n) => (names.push(n), '([^/]+)'))
          .replace(/\*/g, () => (names.push('splat'), '(.*)')) +
        '/?$',
    );
    const m = re.exec(url);
    if (!m) continue;
    let target = to;
    names.forEach((n, i) => (target = target.replace(`:${n}`, m[i + 1])));
    return norm(target);
  }
  return undefined;
}

// --- replay -----------------------------------------------------------------
const commits = git('rev-list', '--first-parent', '--reverse', 'HEAD', '--', `src/pages/${lang}`, `src/content/docs/${lang}`)
  .trim()
  .split('\n');
const files = new Map(); // path -> blob
let lock = { permalock: 1, urls: {} };
const t0 = Date.now();
const decisions = []; // automatic redirects
const orphanEvents = new Map(); // url -> first commit where it became an orphan
const everPage = new Set();
let prev = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree
for (const [i, c] of commits.entries()) {
  const raw = git('diff-tree', '-r', '--no-renames', '--raw', prev, c, '--', `src/pages/${lang}`, `src/content/docs/${lang}`);
  for (const line of raw.split('\n')) {
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([AMDT])\t(.+)$/.exec(line);
    if (!m) continue;
    if (m[2] === 'D') files.delete(m[3]);
    else files.set(m[3], m[1]);
  }
  prev = c;
  const pages = [];
  for (const [f, blob] of files) {
    const url = urlFor(f);
    if (!url) continue;
    pages.push({ url, source: f, ...(await fingerprintBlob(blob)) });
  }
  const before = lock;
  const r = resolve({ lock, pages });
  const date = git('show', '-s', '--format=%as', c).trim();
  for (const d of r.redirected) decisions.push({ ...d, commit: c.slice(0, 9), date });
  for (const o of r.orphans) if (!orphanEvents.has(o.url)) orphanEvents.set(o.url, { commit: c.slice(0, 9), date, suggestion: o.suggestion });
  // the bench plays a maintainer who decides every orphan the way the real
  // maintainers eventually did: their redirect rule if one exists, else a removal
  lock = r.lock;
  for (const o of r.orphans) {
    const human = humanTarget(o.url.replace(/\/$/, ''));
    lock.urls[o.url] = human && human !== o.url ? { type: 'redirect', to: human, reason: 'human' } : { type: 'gone' };
  }
  for (const p of pages) everPage.add(p.url);
  if (i % 250 === 0) process.stderr.write(`\r${i}/${commits.length} commits, ${everPage.size} URLs seen`);
}
catFile.stdin.end();
process.stderr.write('\r\x1b[K');

// --- score ------------------------------------------------------------------
const finalLock = lock;
const finalTarget = (from) => {
  let t = finalLock.urls[from];
  let to = from;
  const seen = new Set();
  while (t && t.type === 'redirect' && !seen.has(to)) {
    seen.add(to);
    to = t.to;
    t = finalLock.urls[to];
  }
  return norm(to);
};
const live = new Set(Object.entries(finalLock.urls).filter(([, e]) => e.type === 'page').map(([u]) => u));
const vanished = [...everPage].filter((u) => !live.has(u));
const byReason = {};
const scored = { agree: 0, disagree: 0, noHumanRule: 0 };
const disagreements = [];
for (const d of decisions) {
  const kind = d.reason.startsWith('similar') ? 'similar' : d.reason;
  byReason[kind] = (byReason[kind] ?? 0) + 1;
}
// a decision is checked against the human rule for the same old URL (if any)
const autoFrom = new Map(decisions.map((d) => [d.from, d]));
for (const [from, d] of autoFrom) {
  const human = humanTarget(from.replace(/\/$/, ''));
  const ours = finalTarget(from);
  if (!human) scored.noHumanRule++;
  else if (human === ours || finalTarget(human) === ours) scored.agree++;
  else {
    scored.disagree++;
    disagreements.push({ from, ours, human, reason: d.reason, date: d.date });
  }
}
const orphans = [...orphanEvents.keys()];
const orphanCovered = orphans.filter((u) => humanTarget(u.replace(/\/$/, ''))).length;
const report = {
  repo: git('config', '--get', 'remote.origin.url').trim(),
  head: git('rev-parse', '--short', 'HEAD').trim(),
  lang,
  commitsReplayed: commits.length,
  seconds: Math.round((Date.now() - t0) / 1000),
  urlsEverPublished: everPage.size,
  urlsLiveAtHead: live.size,
  urlsVanished: vanished.length,
  automaticRedirects: autoFrom.size,
  automaticByReason: byReason,
  checkedAgainstHumanRules: scored,
  orphans: orphans.length,
  orphansWithHumanRedirect: orphanCovered,
  orphansWithoutAnyRedirect: orphans.length - orphanCovered,
  disagreements,
  orphanList: orphans.map((u) => ({ url: u, ...orphanEvents.get(u), human: humanTarget(u.replace(/\/$/, '')) })),
};
if (values.json) (await import('node:fs')).writeFileSync(values.json, JSON.stringify(report, null, 2));
report.automaticList = decisions.map((d) => ({ ...d, final: finalTarget(d.from), human: humanTarget(d.from.replace(/\/$/, '')) }));
const { disagreements: _d, orphanList: _o, automaticList: _a, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
console.log('\nEstimated (similar content) redirects:');
for (const d of report.automaticList.filter((x) => x.reason.startsWith('similar')))
  console.log(`  ${d.date} ${d.from} -> ${d.to} (${d.reason}); human rule: ${d.human ?? 'none'}`);
if (disagreements.length) {
  console.log('\nAutomatic redirects that differ from the human rule:');
  for (const d of disagreements) console.log(`  ${d.date} ${d.from} -> ours ${d.ours} | human ${d.human} (${d.reason})`);
}
