import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { article, TEXT, tmp, writeTree } from './helpers.js';
import { serve } from './server.js';

function runAsync(cwd: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    execFile(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
      res({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

const pkg = path.resolve(__dirname, '..');
const cli = path.join(pkg, 'dist', 'cli.js');

function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('cli', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsc', '-p', '.'], { cwd: pkg });
  });

  it('protects a site end to end', async () => {
    const cwd = tmp();
    writeTree(cwd, {
      'dist/index.html': article('Home', TEXT.b),
      'dist/blog/hello-world/index.html': article('Hello', TEXT.a),
      'dist/blog/pasta/index.html': article('Pasta', TEXT.c),
      'dist/promo/index.html': article('Promo', 'short page'),
    });

    // first build: lockfile created
    let r = run(cwd, 'update');
    expect(r.code).toBe(0);
    expect(r.out).toContain('created permalock.json with 4 URLs');

    // rename a post (same content) and delete the promo
    renameSync(path.join(cwd, 'dist/blog/hello-world'), path.join(cwd, 'dist/blog/hello'));
    rmSync(path.join(cwd, 'dist/promo'), { recursive: true });

    // CI check: orphan fails the build, nothing written
    const before = readFileSync(path.join(cwd, 'permalock.json'), 'utf8');
    r = run(cwd, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('/blog/hello-world/ → /blog/hello/');
    expect(r.out).toContain('identical content');
    expect(r.out).toMatch(/✗ \/promo\/\s+orphan/);
    expect(r.out).toContain('permalock retire /promo/');
    expect(readFileSync(path.join(cwd, 'permalock.json'), 'utf8')).toBe(before);
    // agents get ready-to-run fixes
    const failing = JSON.parse(run(cwd, 'check', '--json').out);
    expect(failing.ok).toBe(false);
    expect(failing.orphans[0].fixes.at(-1)).toBe('permalock retire /promo/ --reason "<why>"');

    // decide, then update writes the redirect
    r = run(cwd, 'retire', '/promo/', '--reason', 'campaign ended');
    expect(r.code).toBe(0);
    r = run(cwd, 'update');
    expect(r.code).toBe(0);
    const lock = JSON.parse(readFileSync(path.join(cwd, 'permalock.json'), 'utf8'));
    expect(lock.urls['/blog/hello-world/']).toEqual({ type: 'redirect', to: '/blog/hello/', reason: 'same-content' });
    expect(lock.urls['/promo/']).toEqual({ type: 'gone', reason: 'campaign ended' });

    // check now passes, and --frozen passes because the lockfile is current
    expect(run(cwd, 'check', '--frozen').code).toBe(0);

    // json output
    const j = JSON.parse(run(cwd, 'check', '--json').out);
    expect(j.ok).toBe(true);

    // emit for Netlify
    r = run(cwd, 'emit', 'netlify');
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(cwd, 'dist/_redirects'), 'utf8')).toContain('/blog/hello-world/ /blog/hello/ 301');

    // verify against a server that behaves
    const s = await serve({
      '/': { status: 200 },
      '/blog/hello/': { status: 200 },
      '/blog/pasta/': { status: 200 },
      '/blog/hello-world/': { status: 301, location: '/blog/hello/' },
      '/promo/': { status: 410 },
    });
    try {
      r = await runAsync(cwd, 'verify', '--against', s.origin);
      expect(r.out).toContain('5 pass');
      expect(r.code).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('manual redirect, frozen failure and usage errors', () => {
    const cwd = tmp();
    writeTree(cwd, { 'build/index.html': article('Home'), 'build/a/index.html': article('A', TEXT.b) });
    expect(run(cwd, 'update').code).toBe(0);
    writeTree(cwd, { 'build/b/index.html': article('B', TEXT.c) });
    // new page: check passes but lockfile is stale -> --frozen fails
    expect(run(cwd, 'check').code).toBe(0);
    expect(run(cwd, 'check', '--frozen').code).toBe(1);
    const r = run(cwd, 'redirect', 'old', '/a/');
    expect(r.out).toContain('/old → /a/');
    expect(run(cwd, 'redirect', '/x/').code).toBe(2);
    expect(run(cwd, 'nope').out).toContain('unknown command');
    expect(run(cwd, '--help').out).toContain('Usage: permalock');
  });

  it('merge driver resolves concurrent additions', () => {
    const cwd = tmp();
    const base = '{"permalock":1,"urls":{"/":{"type":"page"}}}';
    writeFileSync(path.join(cwd, 'base'), base);
    writeFileSync(path.join(cwd, 'ours'), '{"permalock":1,"urls":{"/":{"type":"page"},"/a/":{"type":"page"}}}');
    writeFileSync(path.join(cwd, 'theirs'), '{"permalock":1,"urls":{"/":{"type":"page"},"/b/":{"type":"page"}}}');
    expect(run(cwd, 'merge-driver', 'base', 'ours', 'theirs').code).toBe(0);
    expect(readFileSync(path.join(cwd, 'ours'), 'utf8')).toContain('"/b/"');
  });

  it('init sets up .gitattributes', () => {
    const cwd = tmp();
    execFileSync('git', ['init', '-q'], { cwd });
    writeTree(cwd, { 'dist/index.html': article('Home') });
    const r = run(cwd, 'init');
    expect(r.code).toBe(0);
    expect(existsSync(path.join(cwd, 'permalock.json'))).toBe(true);
    expect(readFileSync(path.join(cwd, '.gitattributes'), 'utf8')).toContain('merge=permalock');
    expect(execFileSync('git', ['config', 'merge.permalock.driver'], { cwd, encoding: 'utf8' })).toContain('merge-driver');
  });
});
