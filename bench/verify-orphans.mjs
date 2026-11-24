#!/usr/bin/env node
// Checks on the live site the orphan URLs found by bench/history.mjs.
// Usage: node bench/verify-orphans.mjs bench/results/withastro-docs.json
import { readFileSync } from 'node:fs';
import { checkLive } from '../packages/permalock/dist/index.js';

const file = process.argv[2];
const r = JSON.parse(readFileSync(file, 'utf8'));
const urls = r.orphanList.map((o) => o.url);
const live = await checkLive(r.site, urls, { concurrency: 4 });
const by = { ok: [], redirect: [], chain: [], broken: [], error: [] };
for (const l of live) by[l.state].push(l);
const lines = [];
lines.push(`## ${r.site}: ${urls.length} URLs that disappeared from the content without an automatic redirect`);
lines.push('');
lines.push(`| Today | Count |`, `|---|---|`);
for (const [k, v] of Object.entries(by)) lines.push(`| ${k} | ${v.length} |`);
lines.push('');
for (const l of [...by.broken, ...by.chain, ...by.error]) {
  const o = r.orphanList.find((x) => x.url === l.path);
  lines.push(`- \`${l.path}\` → ${l.state} (${l.status ?? l.detail ?? ''}${l.final ? ` → ${l.final}` : ''}), removed ${o?.date ?? '?'}`);
}
console.log(lines.join('\n'));
