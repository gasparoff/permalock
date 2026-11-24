import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'permalock-test-'));
}

export function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
}

const LOREM = `Permalock keeps every URL a site ever published alive. A link shared five years ago in a forum,
a bookmark in a browser, a citation in a paper and an answer from an AI assistant all point at an address
that the site promised, implicitly, to keep. Static site generators rebuild everything from scratch and
forget the previous build, so a renamed file silently becomes a broken link. The lockfile remembers.`;

export function article(title: string, body = LOREM, extra = '') {
  return `<!doctype html><html><head><title>${title}</title>${extra}</head><body>
<header><nav><a href="/">Home</a> <a href="/blog/">Blog</a></nav></header>
<main><h1>${title}</h1><p>${body}</p></main>
<footer>© 2026 Example</footer><script>console.log("x")</script></body></html>`;
}

export const TEXT = {
  a: LOREM,
  b: `Astro builds static sites from components and content collections. Each page in src/pages becomes a route,
and dynamic routes generate one page per entry. Integrations can hook into the build to read every route and every
generated file, which makes it possible to compare the URLs of this build with the URLs of every previous one and to
fail the build when one of them disappears without a redirect or a declared removal.`,
  c: `Cooking pasta well needs a large pot, plenty of salted water and attention to the clock. Stir in the first
minute so that nothing sticks, taste two minutes before the time on the packet, and keep a cup of the cooking water
to finish the sauce. The starch in that water binds the sauce to the pasta and makes it glossy instead of watery.`,
};
