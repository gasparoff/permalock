import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'astro';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');
const example = path.join(repo, 'examples/astro-blog');

/** Copy the example site into a temp dir that resolves packages from the repo. */
function fixture(config?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'permalock-astro-'));
  cpSync(path.join(example, 'src'), path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}');
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  writeFileSync(
    path.join(dir, 'astro.config.mjs'),
    config ??
      `import permalock from '@permalock/astro';
export default { site: 'https://example.com', trailingSlash: 'always', cacheDir: './.cache', integrations: [permalock()] };`,
  );
  return dir;
}

async function astroBuild(root: string) {
  const logs: string[] = [];
  let error: Error | undefined;
  try {
    await build({ root, logLevel: 'silent' });
  } catch (e) {
    error = e as Error;
  }
  return { error, logs };
}

const lockOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'permalock.json'), 'utf8'));
const md = (dir: string, name: string) => path.join(dir, 'src/content/blog', name);

const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'NETLIFY', 'VERCEL', 'CF_PAGES'];
const saved = Object.fromEntries(CI_VARS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
beforeEach(() => {
  for (const k of CI_VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of CI_VARS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

describe('@permalock/astro', () => {
  it('locks pages with their identity on the first build', async () => {
    const dir = fixture();
    dirs.push(dir);
    const r = await astroBuild(dir);
    expect(r.error).toBeUndefined();
    const lock = lockOf(dir);
    expect(lock.site).toBe('https://example.com');
    expect(lock.urls['/about/'].source).toBe('src/pages/about.astro');
    expect(lock.urls['/blog/hello-world/'].source).toBe('src/content/blog/hello-world.md');
    // the blog index lists every post: no single identity from content
    expect(lock.urls['/blog/'].source).toBe('src/pages/blog/index.astro');
  });

  it('redirects a changed slug, fails on an orphan, then serves native redirects', async () => {
    const dir = fixture();
    expect((await astroBuild(dir)).error).toBeUndefined();

    // slug change through front matter + deleted post
    const hello = md(dir, 'hello-world.md');
    writeFileSync(hello, readFileSync(hello, 'utf8').replace('title: Hello, world', 'title: Hello, world\nslug: hello'));
    rmSync(md(dir, 'summer-sale.md'));
    const r = await astroBuild(dir);
    expect(r.error?.message).toMatch(/1 URL would break/);
    let lock = lockOf(dir);
    expect(lock.urls['/blog/hello-world/']).toEqual({ type: 'redirect', to: '/blog/hello/', reason: 'same-source' });
    expect(lock.urls['/blog/summer-sale/'].type).toBe('page');
    // the redirect works in this very build, as an HTML page
    expect(readFileSync(path.join(dir, 'dist/blog/hello-world/index.html'), 'utf8')).toContain('url=/blog/hello/');

    // decide the orphan, build again: passes, redirects come from the Astro config
    lock.urls['/blog/summer-sale/'] = { type: 'gone', reason: 'sale ended' };
    writeFileSync(path.join(dir, 'permalock.json'), JSON.stringify(lock));
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(readFileSync(path.join(dir, 'dist/blog/hello-world/index.html'), 'utf8')).toContain('Redirecting from');
    lock = lockOf(dir);
    expect(lock.urls['/blog/summer-sale/']).toEqual({ type: 'gone', reason: 'sale ended' });
  });

  it('a renamed file with identical content is a certain redirect', async () => {
    const dir = fixture();
    expect((await astroBuild(dir)).error).toBeUndefined();
    renameSync(md(dir, 'pasta.md'), md(dir, 'perfect-pasta.md'));
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(lockOf(dir).urls['/blog/pasta/']).toEqual({ type: 'redirect', to: '/blog/perfect-pasta/', reason: 'same-content' });
  });

  it('a stable id in front matter survives a rename and an edit', async () => {
    const dir = fixture();
    const pasta = md(dir, 'pasta.md');
    writeFileSync(pasta, readFileSync(pasta, 'utf8').replace('title: Cooking pasta', 'title: Cooking pasta\npermalock: pasta-guide'));
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(lockOf(dir).urls['/blog/pasta/'].source).toBe('id:pasta-guide');
    const text = readFileSync(pasta, 'utf8').replace('taste two minutes', 'taste three minutes').replace('large pot', 'very large pot');
    rmSync(pasta);
    writeFileSync(md(dir, 'pasta-done-right.md'), text);
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(lockOf(dir).urls['/blog/pasta/']).toEqual({ type: 'redirect', to: '/blog/pasta-done-right/', reason: 'same-source' });
  });

  it('handles base and trailingSlash "never", and emits host rules', async () => {
    const dir = fixture(`import permalock from '@permalock/astro';
export default { site: 'https://example.com', base: '/docs', trailingSlash: 'never', build: { format: 'file' }, cacheDir: './.cache', integrations: [permalock({ emit: 'netlify' })] };`);
    expect((await astroBuild(dir)).error).toBeUndefined();
    const lock = lockOf(dir);
    expect(Object.keys(lock.urls).sort()).toEqual([
      '/docs',
      '/docs/about',
      '/docs/blog',
      '/docs/blog/hello-world',
      '/docs/blog/pasta',
      '/docs/blog/summer-sale',
    ]);
    renameSync(md(dir, 'pasta.md'), md(dir, 'perfect-pasta.md'));
    rmSync(md(dir, 'summer-sale.md'));
    lock.urls['/docs/blog/summer-sale'] = { type: 'gone' };
    writeFileSync(path.join(dir, 'permalock.json'), JSON.stringify(lock));
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(lockOf(dir).urls['/docs/blog/pasta']).toEqual({ type: 'redirect', to: '/docs/blog/perfect-pasta', reason: 'same-content' });
    // next build: native redirect with base applied once
    expect((await astroBuild(dir)).error).toBeUndefined();
    const redirectPage = readFileSync(path.join(dir, 'dist/blog/pasta.html'), 'utf8');
    expect(redirectPage).toContain('url=/docs/blog/perfect-pasta"');
    const rules = readFileSync(path.join(dir, 'dist/_redirects'), 'utf8');
    expect(rules).toContain('/docs/blog/pasta /docs/blog/perfect-pasta 301!');
    expect(rules).toContain('/docs/blog/summer-sale /docs/404.html 410!');
  });

  it('a page that exists again wins over a lockfile redirect', async () => {
    const dir = fixture();
    expect((await astroBuild(dir)).error).toBeUndefined();
    const lock = lockOf(dir);
    lock.urls['/about/'] = { type: 'redirect', to: '/blog/', reason: 'manual' };
    writeFileSync(path.join(dir, 'permalock.json'), JSON.stringify(lock));
    expect((await astroBuild(dir)).error).toBeUndefined();
    expect(lockOf(dir).urls['/about/'].type).toBe('page');
    expect(readFileSync(path.join(dir, 'dist/about/index.html'), 'utf8')).not.toContain('http-equiv="refresh"');
  });

  it('in CI it does not write the lockfile and reports when it is stale', async () => {
    const dir = fixture();
    expect((await astroBuild(dir)).error).toBeUndefined();
    const before = readFileSync(path.join(dir, 'permalock.json'), 'utf8');
    renameSync(md(dir, 'pasta.md'), md(dir, 'perfect-pasta.md'));
    process.env.CI = 'true';
    expect((await astroBuild(dir)).error).toBeUndefined();
    delete process.env.CI;
    expect(readFileSync(path.join(dir, 'permalock.json'), 'utf8')).toBe(before);
    // the redirect still works in this deploy
    expect(existsSync(path.join(dir, 'dist/blog/pasta/index.html'))).toBe(true);
  });
});
